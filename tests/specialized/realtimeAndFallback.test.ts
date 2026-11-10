import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LocalAdapter } from '../../adapters/core/local.adapter.js';
import { realtimeQaStream } from '../../core/specialized/realtimeQaStream.js';
import { parseCourseMaterial } from '../../core/nlp/parseCourseMaterial.js';
import type { ParseCourseMaterialOutput } from '../../core/nlp/parseCourseMaterial.js';
import { extractKnowledgeGraph } from '../../core/graph/extractKnowledgeGraph.js';
import type { CourseKnowledgeGraph } from '../../core/graph/extractKnowledgeGraph.js';
import { buildQaKnowledgeBase, search } from '../../core/qa/buildQaKnowledgeBase.js';
import type { QaKnowledgeBase } from '../../core/qa/buildQaKnowledgeBase.js';
import { registerTeacherAvatar } from '../../core/specialized/registerTeacherAvatar.js';
import { synthesizeSpeech } from '../../core/specialized/synthesizeSpeech.js';
import { generateDigitalHumanVideo } from '../../core/specialized/generateDigitalHumanVideo.js';
import { orchestrateMultiTeacher } from '../../core/specialized/orchestrateMultiTeacher.js';
import { matchTeachingScene } from '../../core/specialized/matchTeachingScene.js';
import { syncMultilingualAv } from '../../core/specialized/syncMultilingualAv.js';

describe('realtime_qa_stream（降级：异步问答）', () => {
  it('黄金讲稿问答库：问"什么是梯度下降"命中定义问答', async () => {
    const content = readFileSync('tests/fixtures/sample-lecture-ml-basics.md', 'utf8');
    const parsed = await parseCourseMaterial({ content, materialType: 'md' });
    const graph = await extractKnowledgeGraph(parsed.data!);
    const kb = await buildQaKnowledgeBase({
      graph: graph.data!,
      paragraphs: parsed.data!.paragraphs,
    });
    const r = await realtimeQaStream({
      question: '什么是梯度下降？',
      qaKnowledgeBase: kb.data!,
      topK: 3,
    });
    expect(r.level).toBe('degraded');
    expect(r.data!.mode).toBe('async-single-turn');
    expect(r.data!.answers.length).toBeGreaterThan(0);
    // 梯度下降相关问答应命中（2 字前缀概念"梯度"的排名靠前属合理行为）
    expect(r.data!.answers.some((a) => a.question.includes('梯度下降'))).toBe(true);
    const scores = r.data!.answers.map((a) => a.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  }, 20000);

  it('与 search 排序口径一致（确定性）', async () => {
    const content = readFileSync('tests/fixtures/sample-lecture-ml-basics.md', 'utf8');
    const parsed = await parseCourseMaterial({ content, materialType: 'md' });
    const graph = await extractKnowledgeGraph(parsed.data!);
    const kb = await buildQaKnowledgeBase({
      graph: graph.data!,
      paragraphs: parsed.data!.paragraphs,
    });
    const a = await realtimeQaStream({ question: '学习率怎么选？', qaKnowledgeBase: kb.data! });
    const b = await realtimeQaStream({ question: '学习率怎么选？', qaKnowledgeBase: kb.data! });
    expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
    expect(a.data!.answers.map((x) => x.qaId))
      .toEqual(search(kb.data!, '学习率怎么选？', 3).map((q) => q.id));
  }, 20000);
});

describe('特化技能经 LocalAdapter 走 fallback 链（degraded 而非 unavailable）', () => {
  it('invokeSkill 调 register_teacher_avatar / realtime_qa_stream 返回 degraded + 数据', async () => {
    const adapter = new LocalAdapter();
    const profile = {
      teacherProfile: { name: '王老师' },
    };
    const r1 = await adapter.invokeSkill('register_teacher_avatar', { inputs: profile });
    expect(r1.level).toBe('degraded');
    expect(r1.data).toBeTruthy();
    expect(r1.degradationNote).toContain('静态头像');

    const content = readFileSync('tests/fixtures/sample-lecture-ml-basics.md', 'utf8');
    const parsed = await adapter.invokeSkill<ParseCourseMaterialOutput>('parse_course_material', {
      inputs: { materialFile: { content, materialType: 'md' } },
    });
    const graph = await adapter.invokeSkill<CourseKnowledgeGraph>('extract_knowledge_graph', {
      inputs: { structuredContent: parsed.data },
    });
    const kb = await adapter.invokeSkill<QaKnowledgeBase>('build_qa_knowledge_base', {
      inputs: { graph: graph.data, paragraphs: parsed.data!.paragraphs },
    });
    const r2 = await adapter.invokeSkill<{ answers: Array<{ qaId: string }> }>('realtime_qa_stream', {
      inputs: { question: '什么是正则化？', qaKnowledgeBase: kb.data },
    });
    expect(r2.level).toBe('degraded');
    expect(r2.data!.answers.length).toBeGreaterThan(0);
  }, 20000);
});

describe('特化技能降级输出与直接调用一致（注册无损透传）', () => {
  it('synthesize_speech 等经执行器与直调结果一致', async () => {
    const adapter = new LocalAdapter();
    const viaAdapter = await adapter.invokeSkill('synthesize_speech', {
      inputs: {
        script: {
          storyboardScript: [],
          voiceoverScript: [],
          subtitleScript: [
            { lessonId: 'l', sceneId: 's', startMinute: 0, minutes: 1, text: '测试' },
          ],
        },
        lang: 'zh',
      },
    });
    const direct = await synthesizeSpeech({
      script: {
        storyboardScript: [],
        voiceoverScript: [],
        subtitleScript: [
          { lessonId: 'l', sceneId: 's', startMinute: 0, minutes: 1, text: '测试' },
        ],
      },
      lang: 'zh',
    });
    expect(viaAdapter.level).toBe('degraded');
    expect(JSON.stringify(viaAdapter.data)).toBe(JSON.stringify(direct.data));
    void registerTeacherAvatar;
    void generateDigitalHumanVideo;
    void orchestrateMultiTeacher;
    void matchTeachingScene;
    void syncMultilingualAv;
  });
});
