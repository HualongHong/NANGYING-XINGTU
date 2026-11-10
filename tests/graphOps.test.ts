import { describe, expect, it, vi } from 'vitest';
import { diffKnowledgeGraphs, normalizeLabel } from '../core/graph/diffKnowledgeGraphs.js';
import { fuseKnowledgeGraphs } from '../core/graph/fuseKnowledgeGraphs.js';
import { conceptNodeId, type CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';

/** 构造最小图谱：实体 + 可选边 */
function makeGraph(
  labels: string[],
  edges: Array<[string, string, 'related' | 'prerequisite' | 'contains', number?]> = [],
  titles: string[] = [],
): CourseKnowledgeGraph {
  const entities = labels.map((label, i) => ({
    id: conceptNodeId(label), kind: 'concept' as const, label, level: 0, order: i,
  }));
  const relations = edges.map(([a, b, type, w]) => ({
    id: `edge-${conceptNodeId(a)}->${conceptNodeId(b)}:${type}`,
    from: conceptNodeId(a), to: conceptNodeId(b), type, weight: w ?? 1,
  }));
  const hierarchy = titles.map((title, i) => ({ id: `sec-${i}`, title, level: 1, order: i, children: [] }));
  const nodes = [...entities, ...hierarchy.map((h) => ({ id: h.id, kind: 'section' as const, label: h.title, level: 1, order: h.order }))];
  const prereq = relations.filter((e) => e.type === 'prerequisite');
  return {
    entities,
    relations,
    hierarchy,
    prerequisiteGraph: {
      nodes: nodes.map((n) => n.id),
      edges: prereq.map((e) => ({ from: e.from, to: e.to })),
      topoOrder: nodes.map((n) => n.id),
    },
  };
}

describe('normalizeLabel', () => {
  it('去空白/标点/大小写', () => {
    expect(normalizeLabel('梯度下降，梯度')).toBe(normalizeLabel('梯度下降 梯度'));
    expect(normalizeLabel('Loading Buffer')).toBe('loadingbuffer');
  });
});

describe('diff_knowledge_graphs', () => {
  it('同 ID 差集：实体与边增删、weight 变化带 delta', async () => {
    const a = makeGraph(
      ['离心', '比色法'],
      [['离心', '比色法', 'related', 2], ['比色法', '电泳', 'prerequisite', 1]],
      ['第一章 绪论'],
    );
    const b = makeGraph(
      ['离心', '电泳'],
      [['离心', '比色法', 'related', 5], ['离心', '电泳', 'related', 1]],
      ['第一章 绪论', '第二章 实验'],
    );
    const r = await diffKnowledgeGraphs({ graphA: a, graphB: b });
    expect(r.level).toBe('full');
    expect(r.data!.entitiesAdded).toEqual(['电泳']);
    expect(r.data!.entitiesRemoved).toEqual(['比色法']);
    expect(r.data!.edgesChanged).toHaveLength(1);
    expect(r.data!.edgesChanged[0]).toMatchObject({ weightBefore: 2, weightAfter: 5, delta: 3 });
    expect(r.data!.edgesAdded).toHaveLength(1);
    expect(r.data!.edgesRemoved).toHaveLength(1);
    // 相似度：实体 Jaccard = 1/3，章节标题 1/2
    expect(r.data!.similarity.entities).toBeCloseTo(1 / 3);
    expect(r.data!.similarity.sectionTitles).toBeCloseTo(0.5);
  });

  it('归一化标签兜底：ID 不同但归一化标签相同的实体视为同一', async () => {
    const a = makeGraph(['离心（技术）']);
    const b = makeGraph(['离心技术']);
    const r = await diffKnowledgeGraphs({ graphA: a, graphB: b });
    expect(r.data!.entitiesAdded).toEqual([]);
    expect(r.data!.entitiesRemoved).toEqual([]);
  });

  it('LLM 重命名候选：mock 返回对与失败降级', async () => {
    const a = makeGraph(['离心']);
    const b = makeGraph(['离心操作']);
    const ok = await diffKnowledgeGraphs(
      { graphA: a, graphB: b },
      { llm: { complete: async () => '[{"a":"离心","b":"离心操作","reason":"同义"}]' } },
    );
    expect(ok.data!.renamedCandidates).toHaveLength(1);

    const bad = await diffKnowledgeGraphs(
      { graphA: a, graphB: b },
      { llm: { complete: async () => '垃圾' } },
    );
    expect(bad.level).toBe('degraded');
    expect(bad.data!.renamedCandidates).toEqual([]);
  });
});

describe('fuse_knowledge_graphs', () => {
  it('跨来源归并：归一化相等 + 互为子串，进入 alignedGroups 且实体表去重', async () => {
    const g1 = makeGraph(['离心', '比色法'], [['离心', '比色法', 'related', 2]]);
    const g2 = makeGraph(['离心操作', '比色法', '电泳'], [['离心操作', '电泳', 'related', 3]]);
    const r = await fuseKnowledgeGraphs({
      graphs: [g1, g2],
      sources: [{ id: '课件' }, { id: '讲义', weight: 2 }],
    });
    expect(r.level).toBe('full');
    const labels = r.data!.graph.entities.map((e) => e.label);
    expect(labels).toContain('离心');
    expect(labels).toContain('电泳');
    expect(labels).not.toContain('离心操作'); // 归并进"离心"
    const group = r.data!.report.alignedGroups.find((x) => x.canonicalLabel === '离心');
    expect(group!.memberLabels).toContain('离心操作');
    expect(Object.keys(group!.sourceDistribution).sort()).toEqual(['讲义', '课件']);
    // 确定性 ID：同标签同 ID
    expect(r.data!.graph.entities.find((e) => e.label === '离心')!.id).toBe(conceptNodeId('离心'));
  });

  it('related 边加权求和并重过共现阈值；prerequisite 取并集', async () => {
    const g1 = makeGraph(['甲', '乙'], [['甲', '乙', 'related', 1]]);
    const g2 = makeGraph(['甲', '乙'], [['甲', '乙', 'related', 1], ['乙', '丙', 'prerequisite']]);
    const r = await fuseKnowledgeGraphs(
      { graphs: [g1, g2], sources: [{ id: 'a', weight: 1 }, { id: 'b', weight: 2 }] },
      {},
      { cooccurrenceThreshold: 3 },
    );
    const related = r.data!.graph.relations.filter((e) => e.type === 'related');
    expect(related).toHaveLength(1);
    expect(related[0].weight).toBe(1 + 1 * 2); // 1*1 + 1*2
    const prereq = r.data!.graph.relations.filter((e) => e.type === 'prerequisite');
    expect(prereq).toHaveLength(1);
  });

  it('别名投票：多来源出现的归一化别名并入同组', async () => {
    const g1 = makeGraph(['离心']);
    const g2 = makeGraph(['离心']);
    const r = await fuseKnowledgeGraphs({ graphs: [g1, g2], sources: [{ id: 'a' }, { id: 'b' }] });
    const group = r.data!.report.alignedGroups.find((x) => x.canonicalLabel === '离心');
    expect(group!.sourceDistribution).toEqual({ a: 1, b: 1 });
  });

  it('conflicts：前后缀 ≥3 字重合的未归并对进入冲突列表；LLM 兜底归并可消除', async () => {
    const g1 = makeGraph(['比色法测定']);
    const g2 = makeGraph(['比色法标准']);
    const noLlm = await fuseKnowledgeGraphs({ graphs: [g1, g2], sources: [{ id: 'a' }, { id: 'b' }] });
    expect(noLlm.data!.report.conflicts.length).toBeGreaterThan(0);

    const spy = vi.fn(async () => '[["比色法测定","比色法标准"]]');
    const withLlm = await fuseKnowledgeGraphs(
      { graphs: [g1, g2], sources: [{ id: 'a' }, { id: 'b' }] },
      { llm: { complete: spy } },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const labels = withLlm.data!.graph.entities.map((e) => e.label);
    expect(labels).toHaveLength(1);
    expect(withLlm.data!.report.conflicts).toHaveLength(0);
  });

  it('conflicts 收紧：前后缀仅 2 字重合不列入（离心机/离心管）', async () => {
    const g1 = makeGraph(['离心机']);
    const g2 = makeGraph(['离心管']);
    const r = await fuseKnowledgeGraphs({ graphs: [g1, g2], sources: [{ id: 'a' }, { id: 'b' }] });
    expect(r.data!.report.conflicts).toHaveLength(0);
  });

  it('跨文档词表预融合：多来源候选池中的基础概念提升进实体表', async () => {
    // 两图的 top 实体都不含"比色法"，但候选池中均出现
    const g1 = makeGraph(['淀粉的提取', '考马斯亮蓝']);
    const g2 = makeGraph(['还原糖的测定', '标准曲线']);
    const r = await fuseKnowledgeGraphs({
      graphs: [g1, g2],
      sources: [{ id: 'a' }, { id: 'b' }],
      pools: [
        [{ term: '淀粉的提取' }, { term: '比色法', score: 5 }],
        [{ term: '还原糖的测定' }, { term: '比色法', score: 4 }],
      ],
    });
    const labels = r.data!.graph.entities.map((e) => e.label);
    expect(labels).toContain('比色法');
    const group = r.data!.report.alignedGroups.find((x) => x.canonicalLabel === '比色法');
    expect(Object.keys(group!.sourceDistribution).sort()).toEqual(['a', 'b']);
  });

  it('LLM 失败降级：conflicts 如实返回', async () => {
    const g1 = makeGraph(['比色法测定']);
    const g2 = makeGraph(['比色法标准']);
    const r = await fuseKnowledgeGraphs(
      { graphs: [g1, g2], sources: [{ id: 'a' }, { id: 'b' }] },
      { llm: { complete: async () => '不是json' } },
    );
    expect(r.level).toBe('degraded');
    expect(r.data!.report.conflicts.length).toBeGreaterThan(0);
  });

  it('graphs 与 sources 数量不一致返回 unavailable', async () => {
    const r = await fuseKnowledgeGraphs({ graphs: [makeGraph(['甲'])], sources: [] });
    expect(r.level).toBe('unavailable');
  });

  it('R12-2：融合实体补 fuseMeta 来源标记（主来源 + 归并来源全集）', async () => {
    const g1 = makeGraph(['离心', '电泳'], [['离心', '电泳', 'related', 1]]);
    const g2 = makeGraph(['离心操作', '比色法'], [['离心操作', '比色法', 'related', 1]]);
    const r = await fuseKnowledgeGraphs({
      graphs: [g1, g2],
      sources: [{ id: '课件' }, { id: '讲义' }],
    });
    const entities = r.data!.graph.entities;
    // 归并组（离心 + 离心操作 → 离心）：主来源=canonical 标签"离心"所在来源，归并来源=两源
    const merged = entities.find((e) => e.label === '离心')!;
    expect(merged.fuseMeta).toBeDefined();
    expect(merged.fuseMeta!.primarySource).toBe('课件');
    expect(merged.fuseMeta!.mergedSources).toEqual(['讲义', '课件']);
    // 单来源实体：归并来源仅一源
    const single = entities.find((e) => e.label === '电泳')!;
    expect(single.fuseMeta).toMatchObject({ primarySource: '课件', mergedSources: ['课件'] });
    // 确定性：两次融合输出一致
    const r2 = await fuseKnowledgeGraphs({ graphs: [g1, g2], sources: [{ id: '课件' }, { id: '讲义' }] });
    expect(JSON.stringify(r2.data)).toBe(JSON.stringify(r.data));
  });

  it('R12-2：renderStarmap 融合图优先用 fuseMeta 标注来源（旧 source 推断兜底）', async () => {
    const g1 = makeGraph(['离心']);
    const g2 = makeGraph(['比色法']);
    const fused = await fuseKnowledgeGraphs({ graphs: [g1, g2], sources: [{ id: '讲义' }, { id: '课件' }] });
    // 与产业侧节点混合成 fused 图
    const mixed: CourseKnowledgeGraph = {
      ...fused.data!.graph,
      entities: [
        ...fused.data!.graph.entities,
        { id: 'ind-1', kind: 'concept', label: '质检工程师', level: 0, order: 99, nodeType: 'occupation' },
      ],
    };
    const { renderStarmapSvg } = await import('../core/graph/renderStarmap.js');
    const svg = renderStarmapSvg(mixed);
    expect(svg).toContain('融合星图');
    // 图例来源行用 fuseMeta.primarySource（讲义 ×1 / 课件 ×1）
    expect(svg).toContain('讲义 ×1');
    expect(svg).toContain('课件 ×1');
  });
});
