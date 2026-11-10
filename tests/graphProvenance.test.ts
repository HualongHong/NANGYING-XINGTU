import { describe, expect, it } from 'vitest';
import { extractKnowledgeGraph, GRAPH_SCHEMA_VERSION } from '../core/graph/extractKnowledgeGraph.js';
import type { ParseCourseMaterialOutput } from '../core/nlp/parseCourseMaterial.js';
import type { LLMProvider } from '../core/llm.js';

/** 反馈 b 真实形态的最小 parse 输出（两章四段，候选带 occurrences） */
function parsedFixture(): ParseCourseMaterialOutput {
  return {
    structuredSections: [
      { title: '第一章 种群生态学', level: 1, order: 0 },
      { title: '第二章 生态系统', level: 1, order: 1 },
    ],
    paragraphs: [
      { index: 0, text: '种群密度是种群最基本的数量特征。', sectionOrder: 0 },
      { index: 1, text: '种群密度决定调查方法的选择。', sectionOrder: 0 },
      { index: 2, text: '生态系统由生产者与消费者组成。', sectionOrder: 1 },
      { index: 3, text: '能量沿食物链单向流动。', sectionOrder: 1 },
    ],
    knowledgePointCandidates: [
      { term: '种群密度', score: 12, occurrences: [0, 1] },
      { term: '生态系统', score: 8, occurrences: [2] },
      { term: '食物链', score: 6, occurrences: [3] },
    ],
  } as ParseCourseMaterialOutput;
}

describe('R3-2 实体出处与置信度（反馈 b P1-3：实体可核验）', () => {
  it('概念实体带 source（章节+段落索引）与 confidence（0–1 归一）', async () => {
    const r = await extractKnowledgeGraph(parsedFixture());
    expect(r.level).toBe('full');
    const graph = r.data!;
    expect(graph.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
    const density = graph.entities.find((e) => e.label === '种群密度')!;
    expect(density.source).toEqual({ sectionOrder: [0], paragraphIndexes: [0, 1] });
    expect(density.confidence).toBeGreaterThan(0);
    expect(density.confidence).toBeLessThanOrEqual(1);
    // 出现段落越多置信度越高（确定性）
    const eco = graph.entities.find((e) => e.label === '生态系统')!;
    expect(density.confidence!).toBeGreaterThan(eco.confidence!);
    // 出处与段落归属一致
    const chain = graph.entities.find((e) => e.label === '食物链')!;
    expect(chain.source!.sectionOrder).toEqual([1]);
  });

  it('边带 provenance：启发式边 heuristic，LLM 精炼边 llm（LLM 失败回落保持 heuristic）', async () => {
    const heuristic = await extractKnowledgeGraph(parsedFixture());
    expect(heuristic.data!.relations.every((e) => (e.provenance ?? 'heuristic') === 'heuristic')).toBe(true);

    const llm: LLMProvider = {
      complete: async () =>
        JSON.stringify([
          { from: '种群密度', to: '生态系统', type: 'prerequisite' },
          { from: '生态系统', to: '食物链', type: 'related' },
        ]),
    };
    const refined = await extractKnowledgeGraph(parsedFixture(), { llm });
    const llmEdges = refined.data!.relations.filter((e) => e.provenance === 'llm');
    expect(llmEdges.length).toBe(2);
    // contains（章节树）保持 heuristic，不被 LLM 替换
    expect(refined.data!.relations.filter((e) => e.type === 'contains').every((e) => e.provenance === 'heuristic')).toBe(true);
  });
});
