import { describe, expect, it, vi } from 'vitest';
import { parseCourseMaterial } from '../core/nlp/parseCourseMaterial.js';
import {
  extractKnowledgeGraph,
  mergeConceptCandidates,
} from '../core/graph/extractKnowledgeGraph.js';
import type { LLMProvider } from '../core/llm.js';
import type { ParseCourseMaterialOutput } from '../core/nlp/parseCourseMaterial.js';

const LECTURE = `# 机器学习概述

机器学习是人工智能的重要分支，研究如何让计算机从数据中学习规律。

## 监督学习

监督学习利用带标签的数据训练模型，梯度下降是训练模型的核心优化方法。

## 无监督学习

无监督学习处理没有标签的数据，梯度下降在聚类中也有应用。
`;

async function buildParseOutput(): Promise<ParseCourseMaterialOutput> {
  const result = await parseCourseMaterial({ content: LECTURE, materialType: 'md' });
  return result.data!;
}

const EMPTY_FILTER_REPORT = {
  enabled: false, degraded: false, kept: 0, dropped: 0,
  distribution: { term: 0, operation: 0, phrase: 0, noise: 0 },
  droppedSamples: [],
};

/** 手工构造的 ParsedCourse 字面量：概念级测试不依赖上游分词质量 */
function buildLiteralParseOutput(): ParseCourseMaterialOutput {
  return {
    structuredSections: [
      { title: '机器学习概述', level: 1, order: 0 },
      { title: '监督学习', level: 2, order: 1 },
      { title: '无监督学习', level: 2, order: 2 },
    ],
    tables: [],
    paragraphs: [
      { index: 0, text: '机器学习是人工智能的重要分支。', sectionOrder: 0 },
      { index: 1, text: '监督学习利用带标签的数据训练模型。', sectionOrder: 1 },
      { index: 2, text: '梯度下降是监督学习的核心优化方法。', sectionOrder: 1 },
      { index: 3, text: '无监督学习处理没有标签的数据。', sectionOrder: 2 },
      { index: 4, text: '无监督学习也用于降维。', sectionOrder: 2 },
      { index: 4, text: '梯度下降也可以用于聚类。', sectionOrder: 2 },
    ],
    knowledgePointCandidates: [
      { term: '梯度下降', score: 2, occurrences: [2, 4] },
      { term: '监督学习', score: 1, occurrences: [1, 2] },
      { term: '无监督学习', score: 1, occurrences: [3] },
      { term: '聚类', score: 1, occurrences: [4] },
    ],
    llmFilterReport: EMPTY_FILTER_REPORT,
  };
}

describe('extract_knowledge_graph', () => {
  it('章节树正确映射为 contains 包含边', async () => {
    const parsed = await buildParseOutput();
    const result = await extractKnowledgeGraph(parsed);
    expect(result.level).toBe('full');
    const contains = result.data!.relations.filter((e) => e.type === 'contains');
    // 概述(order 0) -> 监督学习(order 1) -> 无监督学习(order 2)
    expect(contains).toHaveLength(2);
    const ids = result.data!.prerequisiteGraph.nodes;
    expect(contains[0].from).toBe(ids[0]);
    expect(contains[0].to).toBe(ids[1]);
    expect(contains[1].from).toBe(ids[0]);
    // 层级树：概述为根，两个二级章节为子
    expect(result.data!.hierarchy).toHaveLength(1);
    expect(result.data!.hierarchy[0].children).toHaveLength(2);
  });

  it('知识点节点归并去重（子串归并、ID 确定性）', () => {
    const merged = mergeConceptCandidates([
      { term: '梯度下降', score: 3, occurrences: [1, 2] },
      { term: '随机梯度下降', score: 2, occurrences: [2] },
      { term: '聚类', score: 1, occurrences: [2] },
    ]);
    // "梯度下降" 与 "随机梯度下降" 互为子串，应归并为一条
    expect(merged.map((c) => c.term)).toEqual(['梯度下降', '聚类']);
    expect(merged[0].occurrences).toEqual([1, 2]);
  });

  it('顺序先修边方向正确（前置章节指向后续章节）', async () => {
    const parsed = await buildParseOutput();
    const result = await extractKnowledgeGraph(parsed);
    const prereq = result.data!.relations.filter((e) => e.type === 'prerequisite');
    const sectionPrereq = prereq.filter((e) => e.from.startsWith('sec-'));
    // 章节链：概述->监督学习，监督学习->无监督学习
    expect(sectionPrereq).toHaveLength(2);
    const byOrder = (id: string) => result.data!.prerequisiteGraph.nodes.indexOf(id);
    for (const e of sectionPrereq) {
      expect(byOrder(e.from)).toBeLessThan(byOrder(e.to));
    }
  });

  it('共现相关边含阈值行为', async () => {
    const parsed = buildLiteralParseOutput();
    // 默认阈值 2：梯度下降与监督学习在段落 2 共现（仅 1 次）→ 不达阈值；
    // 手工构造一对共现 2 次的概念验证阈值上下界
    const withPair: ParseCourseMaterialOutput = {
      ...parsed,
      knowledgePointCandidates: [
        ...parsed.knowledgePointCandidates,
        { term: '损失函数', score: 2, occurrences: [2, 4] },
      ],
    };
    // 阈值 2：梯度下降 × 损失函数在段落 2、4 共现 → 相关边存在
    const strict = await extractKnowledgeGraph(withPair);
    const relatedDefault = strict.data!.relations.filter(
      (e) => e.type === 'related' && e.from.startsWith('con-'),
    );
    expect(relatedDefault.some((e) => e.weight >= 2)).toBe(true);
    const pair = relatedDefault.find((e) => e.weight >= 2)!;
    const labels = [pair.from, pair.to].map(
      (id) => strict.data!.entities.find((n) => n.id === id)!.label,
    );
    expect(labels.sort()).toEqual(['损失函数', '梯度下降']);
    // 阈值抬高到 99 → 知识点相关边被过滤
    const loose = await extractKnowledgeGraph(withPair, {}, { cooccurrenceThreshold: 99 });
    expect(
      loose.data!.relations.filter((e) => e.type === 'related' && e.from.startsWith('con-')),
    ).toHaveLength(0);
  });

  it('注入 mock LLM → 走增强路径且 provider 被调用', async () => {
    const parsed = buildLiteralParseOutput();
    const complete = vi.fn<(prompt: string, options?: unknown) => Promise<string>>(
      async () =>
        '[{"from":"监督学习","to":"无监督学习","type":"prerequisite"}]',
    );
    const result = await extractKnowledgeGraph(parsed, { llm: { complete } });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.level).toBe('full');
    // LLM 关系替换启发式知识点级关系
    const conceptEdges = result.data!.relations.filter((e) => e.from.startsWith('con-'));
    expect(conceptEdges).toHaveLength(1);
    expect(conceptEdges[0].type).toBe('prerequisite');
    // 章节级先修与 contains 边不受影响
    expect(
      result.data!.relations.filter(
        (e) => e.from.startsWith('sec-') && e.type === 'prerequisite',
      ),
    ).toHaveLength(2);
  });

  it('LLM 返回垃圾 → 回落启发式且 level=degraded', async () => {
    const parsed = await buildParseOutput();
    const complete = vi.fn(async () => '这不是 JSON');
    const result = await extractKnowledgeGraph(parsed, { llm: { complete } });
    expect(result.level).toBe('degraded');
    expect(result.degradationNote).toContain('回落启发式');
    // 启发式边仍在
    expect(
      result.data!.relations.filter((e) => e.type === 'prerequisite'),
    ).not.toHaveLength(0);
  });

  it('空输入 → degraded + 空骨架', async () => {
    const result = await extractKnowledgeGraph({
      structuredSections: [],
      paragraphs: [],
      tables: [],
      knowledgePointCandidates: [],
      llmFilterReport: EMPTY_FILTER_REPORT,
    });
    expect(result.level).toBe('degraded');
    expect(result.data!.entities).toEqual([]);
    expect(result.data!.prerequisiteGraph.topoOrder).toEqual([]);
  });

  it('拓扑排序覆盖全部节点且先修在前', async () => {
    const parsed = await buildParseOutput();
    const result = await extractKnowledgeGraph(parsed);
    const { topoOrder, nodes, edges } = result.data!.prerequisiteGraph;
    expect(topoOrder).toHaveLength(nodes.length);
    const pos = new Map(topoOrder.map((id, i) => [id, i]));
    for (const e of edges) {
      expect(pos.get(e.from)!).toBeLessThan(pos.get(e.to)!);
    }
  });
});

describe('mergeShiftedFragments（偏移重叠防线）', () => {
  it('错开窗口归并到词频高者；包含对与 2 字词不参与', async () => {
    const { mergeShiftedFragments: merge } = await import('../core/graph/extractKnowledgeGraph.js');
    const merged = merge([
      { term: '溶剂回收至有机废', score: 2, occurrences: [0] },
      { term: '机溶剂回收至有机', score: 5, occurrences: [1] },
      { term: '监督学习', score: 9, occurrences: [0, 1] },
      { term: '无监督学习', score: 4, occurrences: [2] },
      { term: '离心', score: 3, occurrences: [0] },
      { term: '转速', score: 2, occurrences: [1] },
    ]);
    const byTerm = new Map(merged.map((c) => [c.term, c]));
    // 错开窗口对 → 归并到词频高者
    expect(byTerm.has('机溶剂回收至有机')).toBe(true);
    expect(byTerm.has('溶剂回收至有机废')).toBe(false);
    expect(byTerm.get('机溶剂回收至有机')!.score).toBe(7);
    // 包含对（监督学习/无监督学习）不触发防线
    expect(byTerm.has('监督学习')).toBe(true);
    expect(byTerm.has('无监督学习')).toBe(true);
    // 2 字词对不触发
    expect(byTerm.has('离心')).toBe(true);
    expect(byTerm.has('转速')).toBe(true);
  });
});
