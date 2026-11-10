import { describe, expect, it, vi } from 'vitest';
import { generatePersonalizedFeedback } from '../core/qa/generatePersonalizedFeedback.js';
import { buildQaKnowledgeBase, type QaKnowledgeBase } from '../core/qa/buildQaKnowledgeBase.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';

/** 先修链 A→B→D + 相关 C；B 有两道薄弱题、A 一道薄弱 */
function buildGraph(): CourseKnowledgeGraph {
  const e = (from: string, to: string, type: 'contains' | 'related' | 'prerequisite') => ({
    id: `edge-${from}-${to}-${type}`, from, to, type, weight: 1,
  });
  const edges = [
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
    hierarchy: [],
    prerequisiteGraph: {
      nodes: ['con-a', 'con-b', 'con-c', 'con-d'],
      edges: edges.filter((x) => x.type === 'prerequisite').map((x) => ({ from: x.from, to: x.to })),
      topoOrder: ['con-a', 'con-b', 'con-c', 'con-d'],
    },
  };
}

const QUIZ = {
  learnerId: 'stu-01',
  answers: [
    { conceptId: 'con-b', correct: false },
    { conceptId: 'con-b', correct: true },
    { conceptId: 'con-a', correct: false },
    { conceptId: 'con-d', correct: true },
  ],
};

describe('generate_personalized_feedback', () => {
  it('概念级正确率统计与薄弱标记（<60%）', async () => {
    const result = await generatePersonalizedFeedback({ quiz: QUIZ, graph: buildGraph() });
    expect(result.level).toBe('full');
    const byId = new Map(result.data!.conceptAnalysis.map((a) => [a.conceptId, a]));
    expect(byId.get('con-b')!.accuracy).toBe(0.5);
    expect(byId.get('con-b')!.weak).toBe(true);
    expect(byId.get('con-a')!.weak).toBe(true);
    expect(byId.get('con-d')!.weak).toBe(false);
    expect(result.data!.overall.accuracy).toBe(0.5);
    expect(result.data!.overall.band).toBe('weak');
  });

  it('薄弱根因追溯：先修也弱时指出基础不牢', async () => {
    const result = await generatePersonalizedFeedback({ quiz: QUIZ, graph: buildGraph() });
    const b = result.data!.conceptAnalysis.find((a) => a.conceptId === 'con-b')!;
    expect(b.weakPrerequisites).toEqual(['con-a']);
    const rootCause = result.data!.suggestions.find((s) => s.kind === 'prerequisite_repair')!;
    expect(rootCause.text).toContain('线性回归');
    expect(rootCause.text).toContain('梯度下降');
  });

  it('建议含补救概念与先修复习路径提示', async () => {
    const result = await generatePersonalizedFeedback({ quiz: QUIZ, graph: buildGraph() });
    const kinds = result.data!.suggestions.map((s) => s.kind);
    expect(kinds).toContain('review_concept');
    expect(kinds).toContain('path_hint');
    const pathHint = result.data!.suggestions.find((s) => s.kind === 'path_hint')!;
    expect(pathHint.text).toContain('线性回归 → 梯度下降');
  });

  it('问答库引用：补救建议推荐相关问答', async () => {
    const kb: QaKnowledgeBase = {
      qaPairs: [
        {
          id: 'qa-1',
          question: '什么是梯度下降？',
          answer: '沿梯度反方向迭代更新参数的优化方法。',
          intent: 'concept_definition',
          conceptIds: ['con-b'],
          sourceParagraph: 0,
        },
      ],
      retrievalIndex: { type: 'inverted', terms: {} },
      intentLabels: ['concept_definition', 'concept_relation', 'procedure'],
    };
    const result = await generatePersonalizedFeedback({
      quiz: QUIZ,
      graph: buildGraph(),
      qaKnowledgeBase: kb,
    });
    const qa = result.data!.suggestions.find((s) => s.kind === 'qa_practice')!;
    expect(qa.text).toContain('什么是梯度下降？');
  });

  it('mock LLM 评语与回落', async () => {
    const ok = await generatePersonalizedFeedback(
      { quiz: QUIZ, graph: buildGraph() },
      { llm: { complete: async () => '你的梯度下降部分还需加强，先巩固线性回归会更有帮助。' } },
    );
    expect(ok.level).toBe('full');
    expect(ok.data!.feedback).toContain('梯度下降');

    const bad = await generatePersonalizedFeedback(
      { quiz: QUIZ, graph: buildGraph() },
      { llm: { complete: async () => '' } },
    );
    expect(bad.level).toBe('degraded');
    expect(bad.data!.feedback).toContain('正确率');
  });

  it('确定性：两次运行产物一致', async () => {
    const a = await generatePersonalizedFeedback({ quiz: QUIZ, graph: buildGraph() });
    const b = await generatePersonalizedFeedback({ quiz: QUIZ, graph: buildGraph() });
    expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
  });

  it('空作答 → 模板提示', async () => {
    const result = await generatePersonalizedFeedback({
      quiz: { answers: [] },
      graph: buildGraph(),
    });
    expect(result.data!.feedback).toContain('暂无测验作答记录');
  });
});
