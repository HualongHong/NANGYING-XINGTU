import { describe, expect, it } from 'vitest';
import { designCourseStructure } from '../core/course/designCourseStructure.js';
import { generateTeachingScript } from '../core/course/generateTeachingScript.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';

/** 三章六概念的最小图谱 */
function graphFixture(): CourseKnowledgeGraph {
  const concepts = ['种群密度', '标志重捕法', '样方调查法', '生态系统', '食物链', '能量流动'];
  return {
    schemaVersion: '1.2',
    entities: concepts.map((label, i) => ({
      id: `con-${i}`, kind: 'concept' as const, label, level: 0, order: i,
    })),
    relations: [],
    hierarchy: [
      {
        id: 'sec-0', title: '种群生态学', level: 1, order: 0,
        children: [
          { id: 'sec-1', title: '种群密度', level: 2, order: 1, children: [] },
          { id: 'sec-2', title: '调查方法', level: 2, order: 2, children: [] },
        ],
      },
      { id: 'sec-3', title: '生态系统', level: 1, order: 3, children: [] },
    ],
    prerequisiteGraph: { nodes: [], edges: [], topoOrder: [] },
  };
}

describe('R3-4 design 参数扩展（反馈 c P1：缺省行为不变）', () => {
  it('缺省参数：输出与旧版一致（无 priorKnowledge/courseType/deliverables 回声）', async () => {
    const r = await designCourseStructure({
      graph: graphFixture(),
      objectives: { audience: '本科生', totalMinutes: 45 },
    });
    expect(r.level).toBe('full');
    const cs = r.data!.courseScript as Record<string, unknown>;
    expect(cs.priorKnowledge).toBeUndefined();
    expect(cs.courseType).toBeUndefined();
    expect(cs.deliverables).toBeUndefined();
    for (const m of r.data!.teachingStructure) {
      for (const l of m.lessons) expect(l.priorConceptIds).toBeUndefined();
    }
  });

  it('priorKnowledge：命中概念保留先修链但退出测评点，priorConceptIds 标注', async () => {
    const r = await designCourseStructure({
      graph: graphFixture(),
      objectives: { audience: '本科生', totalMinutes: 45 },
      priorKnowledge: ['种群密度'],
    });
    const cs = r.data!.courseScript;
    expect(cs.priorKnowledge).toEqual(['种群密度']);
    const lessons = r.data!.teachingStructure.flatMap((m) => m.lessons);
    const hit = lessons.find((l) => l.priorConceptIds?.length)!;
    expect(hit).toBeTruthy();
    expect(hit.conceptIds).toContain(hit.priorConceptIds![0]); // 先修链引用保留
    const labels = hit.assessmentPoints;
    expect(labels).not.toContain('种群密度'); // 不作本课测评点
  });

  it('courseType=lab：练习环节占比高于讲授（实验课模板），回声进 courseScript', async () => {
    const lab = await designCourseStructure({
      graph: graphFixture(),
      objectives: { audience: '本科生', totalMinutes: 45 },
      courseType: 'lab',
    });
    expect(lab.data!.courseScript.courseType).toBe('lab');
    const lecture = await designCourseStructure({
      graph: graphFixture(),
      objectives: { audience: '本科生', totalMinutes: 45 },
    });
    const sumOf = (r: typeof lab, kind: string) =>
      r.data!.teachingStructure.flatMap((m) => m.lessons).flatMap((l) => l.phases)
        .filter((p) => p.kind === kind).reduce((s, p) => s + p.minutes, 0);
    expect(sumOf(lab, '练习')).toBeGreaterThan(sumOf(lecture, '练习'));
    expect(sumOf(lab, '讲解')).toBeLessThan(sumOf(lecture, '讲解'));
  });

  it('deliverables 回声进 courseScript.deliverables', async () => {
    const r = await designCourseStructure({
      graph: graphFixture(),
      objectives: { audience: '本科生' },
      deliverables: ['讲义', '习题册', '实验报告模板'],
    });
    expect(r.data!.courseScript.deliverables).toEqual(['讲义', '习题册', '实验报告模板']);
  });
});

describe('R3-5 script 生成约束（反馈 c P1-4）', () => {
  async function structureOf() {
    const r = await designCourseStructure({
      graph: graphFixture(),
      objectives: { audience: '本科生', totalMinutes: 30 },
    });
    return r.data!;
  }

  it('sourceText：讲解环节口播引用原文命中句而非纯模板填空', async () => {
    const structure = await structureOf();
    const r = await generateTeachingScript({
      structure,
      sourceText: '种群密度是种群最基本的数量特征，调查种群密度可用标志重捕法。标志重捕法适用于活动能力强的动物。',
    });
    const allVoice = r.data!.voiceoverScript.map((v) => v.text).join('\n');
    expect(allVoice).toContain('原文参考：');
    expect(allVoice).toContain('种群密度是种群最基本的数量特征');
  });

  it('requiredConcepts：coverage 报告覆盖与未覆盖项', async () => {
    const structure = await structureOf();
    const r = await generateTeachingScript({
      structure,
      requiredConcepts: ['种群密度', '标志重捕法', '不存在的概念'],
    });
    const cov = r.data!.coverage!;
    expect(cov.requiredConcepts).toEqual(['种群密度', '标志重捕法', '不存在的概念']);
    expect(cov.coveredConcepts).toContain('种群密度');
    expect(cov.missingConcepts).toEqual(['不存在的概念']);
    // 未提供 requiredConcepts 时不输出 coverage（缺省行为不变）
    const plain = await generateTeachingScript({ structure });
    expect(plain.data!.coverage).toBeUndefined();
  });
});
