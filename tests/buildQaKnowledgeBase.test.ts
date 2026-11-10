import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildQaKnowledgeBase,
  search,
  type QaKnowledgeBase,
} from '../core/qa/buildQaKnowledgeBase.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import type { ParsedParagraph } from '../core/nlp/parseCourseMaterial.js';
import { parseCourseMaterial } from '../core/nlp/parseCourseMaterial.js';
import { extractKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';

/** 手工构造的图谱字面量：3 概念 + 先修链 A→B→D + 相关边 */
function buildGraph(): CourseKnowledgeGraph {
  const e = (from: string, to: string, type: 'contains' | 'related' | 'prerequisite') => ({
    id: `edge-${from}-${to}-${type}`, from, to, type, weight: 1,
  });
  const edges = [
    e('sec-a', 'sec-b', 'contains'),
    e('con-a', 'con-b', 'prerequisite'),
    e('con-b', 'con-d', 'prerequisite'),
    e('con-b', 'con-c', 'related'),
  ];
  return {
    entities: [
      { id: 'con-a', kind: 'concept', label: '线性回归', level: 0, order: 0 },
      { id: 'con-b', kind: 'concept', label: '梯度下降', level: 0, order: 1 },
      { id: 'con-c', kind: 'concept', label: '聚类', level: 0, order: 2 },
      { id: 'con-d', kind: 'concept', label: '神经网络', level: 0, order: 3 },
    ],
    relations: edges,
    hierarchy: [
      { id: 'sec-a', title: '机器学习概述', level: 1, order: 0, children: [
        { id: 'sec-b', title: '优化方法', level: 2, order: 1, children: [] },
      ] },
    ],
    prerequisiteGraph: {
      nodes: ['sec-a', 'sec-b', 'con-a', 'con-b', 'con-c', 'con-d'],
      edges: edges.filter((x) => x.type === 'prerequisite').map((x) => ({ from: x.from, to: x.to })),
      topoOrder: ['sec-a', 'sec-b', 'con-a', 'con-b', 'con-c', 'con-d'],
    },
  };
}

const PARAGRAPHS: ParsedParagraph[] = [
  { index: 0, text: '线性回归是一种监督学习方法，用直线拟合数据。', sectionOrder: 0 },
  { index: 1, text: '梯度下降是核心优化方法，首先计算梯度，然后沿反方向更新参数，最后迭代直到收敛。', sectionOrder: 1 },
  { index: 2, text: '聚类是无监督学习的典型任务。', sectionOrder: 1 },
  { index: 3, text: '神经网络由多层神经元组成，训练依赖梯度下降。', sectionOrder: 1 },
];

describe('build_qa_knowledge_base', () => {
  it('模板问答：定义型覆盖全部概念，答案来自含标签段落', async () => {
    const result = await buildQaKnowledgeBase({ graph: buildGraph(), paragraphs: PARAGRAPHS });
    expect(result.level).toBe('full');
    const defs = result.data!.qaPairs.filter((q) => q.intent === 'concept_definition');
    expect(defs).toHaveLength(4);
    const gd = defs.find((q) => q.question === '什么是梯度下降？')!;
    expect(gd.answer).toContain('梯度下降是核心优化方法');
    expect(gd.sourceParagraph).toBe(1);
    expect(gd.conceptIds).toEqual(['con-b']);
  });

  it('模板问答：关系型覆盖先修边与共现边', async () => {
    const result = await buildQaKnowledgeBase({ graph: buildGraph(), paragraphs: PARAGRAPHS });
    const rels = result.data!.qaPairs.filter((q) => q.intent === 'concept_relation');
    const questions = rels.map((q) => q.question);
    expect(questions).toContain('线性回归和梯度下降有什么关系？');
    expect(questions).toContain('梯度下降和聚类有什么关系？');
    const prereq = rels.find((q) => q.question === '线性回归和梯度下降有什么关系？')!;
    expect(prereq.answer).toContain('先修');
  });

  it('模板问答：流程型命中含顺序标记的段落', async () => {
    const result = await buildQaKnowledgeBase({ graph: buildGraph(), paragraphs: PARAGRAPHS });
    const procs = result.data!.qaPairs.filter((q) => q.intent === 'procedure');
    expect(procs).toHaveLength(1);
    expect(procs[0].answer).toContain('首先计算梯度');
  });

  it('倒排检索：查"梯度下降"命中相关问答且排序确定', async () => {
    const result = await buildQaKnowledgeBase({ graph: buildGraph(), paragraphs: PARAGRAPHS });
    const kb = result.data!;
    const hits = search(kb, '梯度下降和线性回归是什么关系？', 3);
    expect(hits.length).toBeGreaterThan(0);
    const ids = hits.map((h) => h.id);
    // 相关问答（问题含两术语）应排在纯定义问答之前
    const relIdx = ids.findIndex((id) => kb.qaPairs.find((q) => q.id === id)?.intent === 'concept_relation');
    expect(relIdx).toBe(0);
    // 确定性：两次检索一致
    const hits2 = search(kb, '梯度下降和线性回归是什么关系？', 3);
    expect(hits2.map((h) => h.id)).toEqual(ids);
  });

  it('mock LLM 增强：自然问答替代模板且 conceptIds 映射到图谱 ID', async () => {
    const complete = vi.fn(async () =>
      JSON.stringify([
        { question: '梯度下降怎么做？', answer: '沿梯度反方向迭代更新参数。', concepts: ['梯度下降'] },
      ]),
    );
    const result = await buildQaKnowledgeBase(
      { graph: buildGraph(), paragraphs: PARAGRAPHS },
      { llm: { complete } },
    );
    expect(result.level).toBe('full');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.data!.qaPairs).toHaveLength(1);
    expect(result.data!.qaPairs[0].conceptIds).toEqual(['con-b']);
  });

  it('LLM 返回垃圾 → 回落模板问答且 level=degraded', async () => {
    const complete = vi.fn(async () => 'bad');
    const result = await buildQaKnowledgeBase(
      { graph: buildGraph(), paragraphs: PARAGRAPHS },
      { llm: { complete } },
    );
    expect(result.level).toBe('degraded');
    expect(result.data!.qaPairs.length).toBeGreaterThan(4);
  });

  it('两次运行产物完全一致（确定性）', async () => {
    const a = await buildQaKnowledgeBase({ graph: buildGraph(), paragraphs: PARAGRAPHS });
    const b = await buildQaKnowledgeBase({ graph: buildGraph(), paragraphs: PARAGRAPHS });
    expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
  });

  it('端到端：黄金讲稿链 → 问答库 ≥10 对且检索可命中', async () => {
    const content = readFileSync('tests/fixtures/sample-lecture-ml-basics.md', 'utf8');
    const parsed = await parseCourseMaterial({ content, materialType: 'md' });
    const graph = await extractKnowledgeGraph(parsed.data!);
    const result = await buildQaKnowledgeBase({
      graph: graph.data!,
      paragraphs: parsed.data!.paragraphs,
    });
    expect(result.level).toBe('full');
    expect(result.data!.qaPairs.length).toBeGreaterThanOrEqual(10);
    const hits = search(result.data!, '梯度下降和学习率是什么关系？', 5);
    expect(hits.length).toBeGreaterThan(0);
  }, 20000);
});
