import { describe, expect, it } from 'vitest';
import { buildTeachingKnowledgeBase } from '../core/kb/buildTeachingKnowledgeBase.js';
import { kbRetrieve, FUSE_WEIGHTS } from '../core/kb/kbRetrieve.js';
import type { ParseCourseMaterialOutput } from '../core/nlp/parseCourseMaterial.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import type { TeachingKnowledgeBase } from '../core/kb/kbTypes.js';

function parseOf(texts: string[]): ParseCourseMaterialOutput {
  return {
    structuredSections: [{ title: '第一章', level: 1, order: 0 }],
    paragraphs: texts.map((text, index) => ({ index, text, sectionOrder: 0 })),
    tables: [],
    knowledgePointCandidates: [],
    llmFilterReport: { enabled: false } as never,
  };
}

function fixtureKb(): TeachingKnowledgeBase {
  const graph: CourseKnowledgeGraph = {
    schemaVersion: '1.2',
    entities: [
      { id: 'con-a', kind: 'concept', label: '光合作用', level: 0, order: 0, confidence: 0.9, source: { sectionOrder: [0], paragraphIndexes: [0, 1, 2] } },
      { id: 'con-b', kind: 'concept', label: '光反应', level: 0, order: 1, confidence: 0.8, source: { sectionOrder: [0], paragraphIndexes: [0, 1] } },
      { id: 'con-c', kind: 'concept', label: '碳反应', level: 0, order: 2, confidence: 0.7, source: { sectionOrder: [0], paragraphIndexes: [0, 2] } },
      { id: 'con-e', kind: 'concept', label: '光呼吸作用', level: 0, order: 3, confidence: 0.3, source: { sectionOrder: [0], paragraphIndexes: [] } },
    ],
    relations: [
      { id: 'e2', from: 'con-b', to: 'con-c', type: 'prerequisite', weight: 1 },
      { id: 'e3', from: 'con-a', to: 'con-b', type: 'related', weight: 2 },
      { id: 'e4', from: 'con-a', to: 'con-c', type: 'related', weight: 2 },
    ],
    hierarchy: [],
    prerequisiteGraph: { nodes: [], edges: [], topoOrder: [] },
  };
  return buildTeachingKnowledgeBase({
    materials: [{
      materialId: 'm1',
      parse: parseOf([
        '光合作用分为光反应和碳反应两个阶段。',
        '光反应在类囊体膜上进行，产生 ATP 和 NADPH。',
        '碳反应即卡尔文循环，固定二氧化碳合成有机物。',
        '实验课注意事项：爱护器材，规范操作。',
      ]),
    }],
    graph,
    options: { builtAt: '2026-11-27T00:00:00.000Z' },
  }).data!;
}

describe('kbRetrieve：五段管线', () => {
  it('倒排召回命中：查询词命中证据进入 items（via=direct）', () => {
    const pack = kbRetrieve(fixtureKb(), 'ATP 在哪产生');
    expect(pack.items.length).toBeGreaterThan(0);
    expect(pack.items.some((i) => i.evidenceId === 'ev-m1-p1')).toBe(true);
    expect(pack.items.find((i) => i.evidenceId === 'ev-m1-p1')!.via).toBe('direct');
    expect(pack.stats.invertedHits).toBeGreaterThan(0);
  });

  it('GraphExpand：命中概念的邻域证据以 via=graph 带出；expand=false 关闭', () => {
    const kb = fixtureKb();
    // '类囊体' 只直中 ev-p1（概念 con-a/con-b），邻域 con-c 未直中 → 其证据经 graph 带出
    const on = kbRetrieve(kb, '类囊体', { topK: 10 });
    const off = kbRetrieve(kb, '类囊体', { topK: 10, expand: false });
    expect(on.stats.graphExpanded).toBeGreaterThan(0);
    expect(on.items.some((i) => i.via === 'graph')).toBe(true);
    expect(off.stats.graphExpanded).toBe(0);
    expect(off.items.every((i) => i.via === 'direct')).toBe(true);
    expect(on.items.length).toBeGreaterThanOrEqual(off.items.length);
  });

  it('FuseRank 确定性：同查询同排序（含 tie-break），scoreParts 构成诚实', () => {
    const kb = fixtureKb();
    const a = kbRetrieve(kb, '光合作用 阶段');
    const b = kbRetrieve(kb, '光合作用 阶段');
    expect(a.items.map((i) => i.evidenceId)).toEqual(b.items.map((i) => i.evidenceId));
    for (const item of a.items) {
      const sum = item.scoreParts.inverted + item.scoreParts.vector + item.scoreParts.graph + item.scoreParts.confidence;
      expect(item.score).toBeCloseTo(sum, 10);
    }
    // 置信度加分不超过权重上限
    for (const item of a.items) {
      expect(item.scoreParts.confidence).toBeLessThanOrEqual(0.9 * FUSE_WEIGHTS.confidence + 1e-9);
    }
  });

  it('topK 截断生效', () => {
    const pack = kbRetrieve(fixtureKb(), '光合作用 光反应 碳反应', { topK: 2 });
    expect(pack.items.length).toBeLessThanOrEqual(2);
  });

  it('Budget：token 预算裁剪并如实报告条数', () => {
    const pack = kbRetrieve(fixtureKb(), '光合作用 光反应 碳反应', { topK: 10, budgetTokens: 20 });
    expect(pack.stats.truncatedByBudget).toBeGreaterThan(0);
    expect(pack.note).toContain('裁剪');
    expect(pack.stats.totalTokens).toBeLessThanOrEqual(20);
  });

  it('零命中：空 items + note 诚实出口 + 不硬答', () => {
    const pack = kbRetrieve(fixtureKb(), '量子引力波动方程');
    expect(pack.items).toEqual([]);
    expect(pack.note).toContain('无命中证据');
    expect(pack.note).toContain('采集');
  });

  it('GapReport：命中概念中零证据者入 coverageGaps（含采集建议语义）', () => {
    const pack = kbRetrieve(fixtureKb(), '光呼吸作用 是什么');
    expect(pack.coverageGaps).toBeTruthy();
    expect(pack.coverageGaps!.some((g) => g.conceptId === 'con-e' && g.evidenceCount === 0)).toBe(true);
  });

  it('命中概念与关系边输出（含图谱扩展带出的概念间关系）', () => {
    const pack = kbRetrieve(fixtureKb(), '光反应 类囊体', { topK: 10 });
    const ids = pack.concepts.map((c) => c.id);
    expect(ids).toContain('con-b');
    expect(pack.relations.some((r) => r.from === 'con-b' && r.to === 'con-c' && r.type === 'prerequisite')).toBe(true);
    for (const c of pack.concepts) {
      expect(['corpus', 'external', 'inferred']).toContain(c.origin);
    }
  });

  it('向量得分接口位（R24）：注入 vectorScores 参与融合', () => {
    const kb = fixtureKb();
    const without = kbRetrieve(kb, '实验课 注意', { topK: 5 });
    const withVec = kbRetrieve(kb, '实验课 注意', { topK: 5, vectorScores: new Map([['ev-m1-p3', 0.9]]) });
    expect(withVec.stats.vectorHits).toBe(1);
    const item = withVec.items.find((i) => i.evidenceId === 'ev-m1-p3');
    expect(item).toBeTruthy();
    expect(item!.scoreParts.vector).toBeCloseTo(0.9 * FUSE_WEIGHTS.vector, 10);
    void without;
  });

  it('证据条目带完整出处（材料/章节/段落/citation/origin）', () => {
    const pack = kbRetrieve(fixtureKb(), '卡尔文循环');
    const item = pack.items.find((i) => i.evidenceId === 'ev-m1-p2')!;
    expect(item.materialId).toBe('m1');
    expect(item.sectionOrder).toBe(0);
    expect(item.paragraphIndexes).toEqual([2]);
    expect(item.origin).toBe('corpus');
    expect(item.citation).toEqual({});
  });
});
