import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { importGlossary } from '../core/i18n/glossary.js';
import { translateMultilingual } from '../core/i18n/translateMultilingual.js';
import type { TeachingScript } from '../core/course/generateTeachingScript.js';

const glossary = () => importGlossary(readFileSync('tests/fixtures/glossary.ml-basics.json', 'utf8'));

const SAMPLE_SCRIPT: TeachingScript = {
  storyboardScript: [
    {
      lessonId: 'les-1',
      title: '监督学习',
      scenes: [
        {
          id: 'scene-1',
          lessonId: 'les-1',
          phase: '讲解',
          sceneType: 'PPT展示',
          visual: '画面',
          voiceover: '监督学习利用带标签的数据训练模型，梯度下降是核心方法。',
          subtitle: '监督学习利用带标签的数据训练模型，梯度下降是核心方法。',
          minutes: 8,
          startMinute: 2,
          conceptIds: ['con-a'],
        },
      ],
    },
  ],
  voiceoverScript: [
    { lessonId: 'les-1', title: '监督学习', text: '监督学习利用带标签的数据训练模型，梯度下降是核心方法。' },
  ],
  subtitleScript: [
    { lessonId: 'les-1', sceneId: 'scene-1', startMinute: 2, minutes: 8, text: '监督学习利用带标签的数据训练模型，梯度下降是核心方法。' },
  ],
};

describe('translate_multilingual', () => {
  it('mock LLM 翻译落位，结构字段（id/startMinute/conceptIds）不动', async () => {
    const complete = vi.fn(async () =>
      JSON.stringify([
        'Supervised learning trains models with labeled data; gradient descent is the core method.',
        'Supervised learning trains models with labeled data; gradient descent is the core method.',
      ]),
    );
    const result = await translateMultilingual(
      { script: SAMPLE_SCRIPT, targetLanguages: ['en'], glossary: glossary() },
      { llm: { complete } },
    );
    expect(result.level).toBe('full');
    expect(complete).toHaveBeenCalledTimes(1);
    const en = result.data!.multilingualTexts[0].script as {
      storyboardScript: Array<{
        scenes: Array<{
          voiceover: string;
          subtitle: string;
          id: string;
          startMinute: number;
          minutes: number;
          conceptIds: string[];
        }>;
      }>;
    };
    const scene = en.storyboardScript[0].scenes[0];
    expect(scene.voiceover).toContain('gradient descent');
    expect(scene.id).toBe('scene-1');
    expect(scene.startMinute).toBe(2);
    expect(scene.minutes).toBe(8);
    expect(scene.conceptIds).toEqual(['con-a']);
    // 字幕与口播同步译文
    expect(scene.subtitle).toBe(scene.voiceover);
  });

  it('LLM 术语错译/漏译被词表强制纠正并记入报告', async () => {
    // 模拟 LLM 把"梯度下降"原样留在英文里（漏译）
    const complete = vi.fn(async () =>
      JSON.stringify([
        'Supervised learning trains models with labeled data; 梯度下降 is the core method.',
        'Supervised learning trains models with labeled data; 梯度下降 is the core method.',
      ]),
    );
    const result = await translateMultilingual(
      { script: SAMPLE_SCRIPT, targetLanguages: ['en'], glossary: glossary() },
      { llm: { complete } },
    );
    expect(result.level).toBe('full');
    const en = result.data!.multilingualTexts[0].script as { storyboardScript: Array<{ scenes: Array<{ voiceover: string }> }> };
    expect(en.storyboardScript[0].scenes[0].voiceover).toContain('gradient descent');
    expect(en.storyboardScript[0].scenes[0].voiceover).not.toContain('梯度下降');
    const replaced = result.data!.termReport.filter((r) => r.action === 'replaced');
    expect(replaced.some((r) => r.term === '梯度下降' && r.expected === 'gradient descent')).toBe(true);
  });

  it('LLM 返回垃圾 → 回落术语标注稿且 level=degraded', async () => {
    const complete = vi.fn(async () => '抱歉无法翻译');
    const result = await translateMultilingual(
      { script: SAMPLE_SCRIPT, targetLanguages: ['en'], glossary: glossary() },
      { llm: { complete } },
    );
    expect(result.level).toBe('degraded');
    expect(result.degradationNote).toContain('退化为术语标注稿');
    const en = result.data!.multilingualTexts[0].script as { storyboardScript: Array<{ scenes: Array<{ voiceover: string }> }> };
    const voiceover = en.storyboardScript[0].scenes[0].voiceover;
    // 原文保留 + 术语附英译标注
    expect(voiceover).toContain('监督学习');
    expect(voiceover).toContain('supervised learning');
  });

  it('无 provider 降级：纯文本段落输入同样产出标注稿', async () => {
    const result = await translateMultilingual({
      paragraphs: ['梯度下降用于最小化损失函数。'],
      targetLanguages: ['en'],
      glossary: glossary(),
    });
    expect(result.level).toBe('degraded');
    const en = result.data!.multilingualTexts[0].script as string[];
    expect(en[0]).toContain('梯度下降（gradient descent）');
    expect(en[0]).toContain('损失函数（loss function）');
  });

  it('端到端：黄金讲稿 → script → 翻译 en（mock LLM）', async () => {
    const { parseCourseMaterial } = await import('../core/nlp/parseCourseMaterial.js');
    const { extractKnowledgeGraph } = await import('../core/graph/extractKnowledgeGraph.js');
    const { designCourseStructure } = await import('../core/course/designCourseStructure.js');
    const { generateTeachingScript } = await import('../core/course/generateTeachingScript.js');

    const content = readFileSync('tests/fixtures/sample-lecture-ml-basics.md', 'utf8');
    const parsed = await parseCourseMaterial({ content, materialType: 'md' });
    const graph = await extractKnowledgeGraph(parsed.data!);
    const design = await designCourseStructure({
      graph: graph.data!,
      objectives: { audience: '本科生', totalMinutes: 90 },
    });
    const script = await generateTeachingScript({ structure: design.data! });

    const complete = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('gradient descent');
      // 简单确定性"翻译"：返回原段落（模拟漏译，交由词表纠正）
      const arr: unknown = JSON.parse(prompt.slice(prompt.lastIndexOf('[')));
      return JSON.stringify((arr as string[]).map((s) => `EN: ${s}`));
    });
    const result = await translateMultilingual(
      { script: script.data!, targetLanguages: ['en'], glossary: glossary() },
      { llm: { complete } },
    );
    expect(result.level).toBe('full');
    const en = result.data!.multilingualTexts[0].script as {
      storyboardScript: Array<{ scenes: Array<{ voiceover: string; id: string }> }>;
    };
    const scenes = en.storyboardScript.flatMap((l) => l.scenes);
    expect(scenes.length).toBeGreaterThan(15);
    for (const scene of scenes) {
      expect(scene.voiceover.startsWith('EN: ')).toBe(true);
      expect(scene.voiceover.length).toBeGreaterThan(0);
    }
    // 词表纠正生效：至少出现规范术语译文
    const all = scenes.map((s) => s.voiceover).join('\n');
    expect(all).toContain('gradient descent');
    expect(all).toContain('loss function');
    expect(all).toContain('supervised learning');
    // 报告记录强制替换
    expect(result.data!.termReport.some((r) => r.action === 'replaced')).toBe(true);
  }, 20000);
});
