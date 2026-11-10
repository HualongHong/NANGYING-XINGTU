import { describe, expect, it, vi } from 'vitest';
import { designCourseStructure } from '../core/course/designCourseStructure.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';

/** 手工构造的小型课程图谱：3 章节（含父子）+ 4 概念 + 先修链 A→B→D */
function buildGraph(): CourseKnowledgeGraph {
  const secOverview = 'sec-a';
  const secSupervised = 'sec-b';
  const secUnsupervised = 'sec-c';
  const conA = 'con-a'; // 线性回归
  const conB = 'con-b'; // 梯度下降
  const conC = 'con-c'; // 聚类
  const conD = 'con-d'; // 神经网络
  const nodes = [secOverview, secSupervised, secUnsupervised, conA, conB, conC, conD];
  const e = (from: string, to: string, type: 'contains' | 'related' | 'prerequisite') => ({
    id: `edge-${from}-${to}-${type}`,
    from,
    to,
    type,
    weight: 1,
  });
  const edges = [
    e(secOverview, secSupervised, 'contains'),
    e(secOverview, secUnsupervised, 'contains'),
    e(secOverview, secSupervised, 'prerequisite'),
    e(secSupervised, secUnsupervised, 'prerequisite'),
    e(conA, conB, 'prerequisite'),
    e(conB, conD, 'prerequisite'),
    e(conB, conC, 'related'),
  ];
  return {
    entities: [
      { id: conA, kind: 'concept', label: '线性回归', level: 0, order: 0 },
      { id: conB, kind: 'concept', label: '梯度下降', level: 0, order: 1 },
      { id: conC, kind: 'concept', label: '聚类', level: 0, order: 2 },
      { id: conD, kind: 'concept', label: '神经网络', level: 0, order: 3 },
    ],
    relations: edges,
    hierarchy: [
      {
        id: secOverview,
        title: '机器学习概述',
        level: 1,
        order: 0,
        children: [
          { id: secSupervised, title: '监督学习', level: 2, order: 1, children: [] },
          { id: secUnsupervised, title: '无监督学习', level: 2, order: 2, children: [] },
        ],
      },
    ],
    prerequisiteGraph: {
      nodes,
      edges: edges
        .filter((x) => x.type === 'prerequisite')
        .map((x) => ({ from: x.from, to: x.to })),
      topoOrder: [secOverview, secSupervised, secUnsupervised, conA, conB, conC, conD],
    },
  };
}

const OBJECTIVES = { audience: '本科生', totalMinutes: 90 };

describe('design_course_structure', () => {
  it('模块分组符合策略：层级树根为一模块，模块名由章节标题派生', async () => {
    const result = await designCourseStructure({
      graph: buildGraph(),
      objectives: OBJECTIVES,
    });
    expect(result.level).toBe('full');
    const { teachingStructure, courseScript } = result.data!;
    expect(teachingStructure).toHaveLength(1);
    expect(teachingStructure[0].title).toBe('机器学习概述');
    // 模块覆盖全部三个章节
    expect(teachingStructure[0].sectionIds).toHaveLength(3);
    // courseScript 编排与课时一致
    const lessonIds = teachingStructure[0].lessons.map((l) => l.id);
    expect(courseScript.modules[0].lessonIds).toEqual(lessonIds);
  });

  it('先修课时排在后继之前（概念 A→B→D 的课时序）', async () => {
    const result = await designCourseStructure({
      graph: buildGraph(),
      objectives: OBJECTIVES,
    });
    const lessons = result.data!.teachingStructure[0].lessons;
    const indexOf = (cid: string) =>
      lessons.findIndex((l) => l.conceptIds.includes(cid));
    expect(indexOf('con-a')).toBeGreaterThanOrEqual(0);
    expect(indexOf('con-a')).toBeLessThan(indexOf('con-b'));
    expect(indexOf('con-b')).toBeLessThan(indexOf('con-d'));
  });

  it('知识点与章节 ID 引用与上游确定性 ID 一致', async () => {
    const result = await designCourseStructure({
      graph: buildGraph(),
      objectives: OBJECTIVES,
    });
    const lessons = result.data!.teachingStructure[0].lessons;
    const allConceptIds = new Set(buildGraph().entities.map((e2) => e2.id));
    const allSectionIds = new Set(['sec-a', 'sec-b', 'sec-c']);
    for (const lesson of lessons) {
      for (const cid of lesson.conceptIds) {
        expect(allConceptIds.has(cid)).toBe(true);
      }
      for (const sid of lesson.sectionIds) {
        expect(allSectionIds.has(sid)).toBe(true);
      }
    }
    // 测评点取知识点标签
    const withConB = lessons.find((l) => l.conceptIds.includes('con-b'))!;
    expect(withConB.assessmentPoints).toContain('梯度下降');
  });

  it('时长估算为正且总和不超过总时长约束', async () => {
    const result = await designCourseStructure({
      graph: buildGraph(),
      objectives: OBJECTIVES,
    });
    const { teachingStructure, courseScript } = result.data!;
    for (const lesson of teachingStructure[0].lessons) {
      expect(lesson.minutes).toBeGreaterThan(0);
      const phaseSum = lesson.phases.reduce((s, p) => s + p.minutes, 0);
      expect(phaseSum).toBe(lesson.minutes);
    }
    expect(courseScript.totalMinutes).toBeLessThanOrEqual(90);
  });

  it('注入 mock LLM → provider 被调用且增强生效', async () => {
    const complete = vi.fn<(prompt: string, options?: unknown) => Promise<string>>(
      async () =>
        JSON.stringify({
          moduleTitles: ['机器学习基础'],
          lessonObjectives: ['目标1', '目标2', '目标3'],
          transitions: ['承接总览', '承接监督', '承接无监督'],
        }),
    );
    const result = await designCourseStructure(
      { graph: buildGraph(), objectives: OBJECTIVES },
      { llm: { complete } },
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.level).toBe('full');
    expect(result.data!.teachingStructure[0].title).toBe('机器学习基础');
    for (const lesson of result.data!.teachingStructure[0].lessons) {
      expect(lesson.objective).toBeTruthy();
      expect(lesson.phases[0].transition).toBeTruthy();
    }
  });

  it('LLM 返回垃圾 → 回落启发式且 level=degraded', async () => {
    const complete = vi.fn(async () => '无法完成');
    const result = await designCourseStructure(
      { graph: buildGraph(), objectives: OBJECTIVES },
      { llm: { complete } },
    );
    expect(result.level).toBe('degraded');
    expect(result.degradationNote).toContain('回落启发式');
    // 启发式结构仍在：模块名保持章节标题
    expect(result.data!.teachingStructure[0].title).toBe('机器学习概述');
  });

  it('空图谱 → degraded + 模板化骨架', async () => {
    const empty: CourseKnowledgeGraph = {
      entities: [],
      relations: [],
      hierarchy: [],
      prerequisiteGraph: { nodes: [], edges: [], topoOrder: [] },
    };
    const result = await designCourseStructure({
      graph: empty,
      objectives: { audience: '本科生', totalMinutes: 40 },
    });
    expect(result.level).toBe('degraded');
    const { teachingStructure } = result.data!;
    expect(teachingStructure).toHaveLength(1);
    expect(teachingStructure[0].lessons[0].minutes).toBe(40);
    expect(teachingStructure[0].lessons[0].phases.map((p) => p.kind)).toEqual([
      '导入',
      '讲解',
      '练习',
      '小结',
    ]);
  });
});
