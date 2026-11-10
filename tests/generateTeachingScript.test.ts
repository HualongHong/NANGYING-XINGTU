import { describe, expect, it, vi } from 'vitest';
import { generateTeachingScript } from '../core/course/generateTeachingScript.js';
import type { CourseStructure, Lesson } from '../core/course/designCourseStructure.js';

function makeLesson(id: string, title: string, conceptIds: string[], labels: string[]): Lesson {
  const minutes = [2, 8, 4, 4, 2];
  const kinds = ['导入', '讲解', '示例', '练习', '小结'] as const;
  let cursor = 0;
  return {
    id,
    title,
    moduleId: 'mod-x',
    sectionIds: ['sec-x'],
    conceptIds,
    minutes: 20,
    phases: kinds.map((kind, i) => {
      const m = minutes[i];
      const phase = {
        kind,
        minutes: m,
        conceptIds: kind === '导入' ? [] : conceptIds,
      };
      cursor += m;
      return phase;
    }),
    assessmentPoints: labels,
  };
}

function buildStructure(): CourseStructure {
  const lesson1 = makeLesson('les-1', '监督学习', ['con-a', 'con-b'], ['线性回归', '梯度下降']);
  const lesson2 = makeLesson('les-2', '无监督学习', ['con-c'], ['聚类']);
  return {
    courseScript: {
      title: '机器学习概述',
      audience: '本科生',
      totalMinutes: 40,
      modules: [{ id: 'mod-x', title: '机器学习概述', minutes: 40, lessonIds: ['les-1', 'les-2'] }],
    },
    teachingStructure: [
      {
        id: 'mod-x',
        title: '机器学习概述',
        sectionIds: ['sec-x'],
        lessons: [lesson1, lesson2],
        minutes: 40,
      },
    ],
    teachingFlow: { steps: [], edges: [] },
  };
}

describe('generate_teaching_script', () => {
  it('scene 数与课时环节一一对应', async () => {
    const result = await generateTeachingScript({ structure: buildStructure() });
    expect(result.level).toBe('full');
    const { storyboardScript } = result.data!;
    expect(storyboardScript).toHaveLength(2);
    expect(storyboardScript[0].scenes).toHaveLength(5);
    expect(storyboardScript[0].scenes.map((s) => s.phase)).toEqual([
      '导入',
      '讲解',
      '示例',
      '练习',
      '小结',
    ]);
  });

  it('口播稿非空且包含知识点 label，字幕与口播同源派生', async () => {
    const result = await generateTeachingScript({ structure: buildStructure() });
    const lesson1 = result.data!.storyboardScript[0];
    for (const scene of lesson1.scenes) {
      expect(scene.voiceover.length).toBeGreaterThan(0);
      expect(scene.subtitle).toBe(scene.voiceover);
      expect(scene.minutes).toBeGreaterThan(0);
    }
    // 讲解环节包含知识点 label
    const lecture = lesson1.scenes.find((s) => s.phase === '讲解')!;
    expect(lecture.voiceover).toContain('线性回归');
    expect(lecture.voiceover).toContain('梯度下降');
    // 口播稿全文 = 各 scene 口播拼接
    const voiceoverText = result.data!.voiceoverScript[0].text;
    expect(voiceoverText).toContain(lecture.voiceover);
  });

  it('scene 引用上游课时/知识点 ID，字幕带时码', async () => {
    const result = await generateTeachingScript({ structure: buildStructure() });
    const scenes = result.data!.storyboardScript[0].scenes;
    expect(scenes.every((s) => s.lessonId === 'les-1')).toBe(true);
    const lecture = scenes.find((s) => s.phase === '讲解')!;
    expect(lecture.conceptIds).toEqual(['con-a', 'con-b']);
    const cues = result.data!.subtitleScript.filter((c) => c.lessonId === 'les-1');
    expect(cues[0].startMinute).toBe(0);
    expect(cues[1].startMinute).toBe(cues[0].minutes);
    expect(cues).toHaveLength(5);
  });

  it('讲解有知识点时场景类型为 PPT 展示，导入为标题卡', async () => {
    const result = await generateTeachingScript({ structure: buildStructure() });
    const scenes = result.data!.storyboardScript[0].scenes;
    expect(scenes.find((s) => s.phase === '导入')!.sceneType).toBe('标题卡');
    expect(scenes.find((s) => s.phase === '讲解')!.sceneType).toBe('PPT展示');
    expect(scenes.find((s) => s.phase === '示例')!.sceneType).toBe('示例演示');
  });

  it('注入 mock LLM → provider 被调用且口播被改写', async () => {
    const complete = vi.fn<(prompt: string, options?: unknown) => Promise<string>>(
      async () => JSON.stringify(Array(10).fill('改写后的连贯口播稿')),
    );
    const result = await generateTeachingScript(
      { structure: buildStructure() },
      { llm: { complete } },
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.level).toBe('full');
    const text = result.data!.voiceoverScript[0].text;
    expect(text).toContain('改写后的连贯口播稿');
    // 字幕与口播同步改写（同源派生）
    expect(result.data!.subtitleScript[0].text).toBe('改写后的连贯口播稿');
  });

  it('LLM 返回垃圾 → 回落启发式且 level=degraded', async () => {
    const complete = vi.fn(async () => 'not json at all');
    const result = await generateTeachingScript(
      { structure: buildStructure() },
      { llm: { complete } },
    );
    expect(result.level).toBe('degraded');
    expect(result.degradationNote).toContain('回落启发式');
    // 启发式模板稿仍在
    const lecture = result.data!.storyboardScript[0].scenes.find((s) => s.phase === '讲解')!;
    expect(lecture.voiceover).toContain('线性回归');
  });

  it('空课程结构 → degraded + 空脚本', async () => {
    const empty: CourseStructure = {
      courseScript: { title: '', audience: '', totalMinutes: 0, modules: [] },
      teachingStructure: [],
      teachingFlow: { steps: [], edges: [] },
    };
    const result = await generateTeachingScript({ structure: empty });
    expect(result.level).toBe('degraded');
    expect(result.data!.storyboardScript).toEqual([]);
  });
});
