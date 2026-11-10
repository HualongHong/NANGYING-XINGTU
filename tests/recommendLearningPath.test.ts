import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { recommendLearningPath } from '../core/graph/recommendLearningPath.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import { parseCourseMaterial } from '../core/nlp/parseCourseMaterial.js';
import { extractKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';

/** 与 extract 测试一致的小型图谱：先修链 A→B→D + 相关 C */
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

describe('recommend_learning_path', () => {
  it('全量路径 = topoOrder 合法序（无画像时默认顺序）', async () => {
    const result = await recommendLearningPath({
      graph: buildGraph(),
      profile: {},
    });
    expect(result.level).toBe('full');
    expect(result.data!.learningSequence).toEqual(['sec-a', 'sec-b', 'con-a', 'con-b', 'con-c', 'con-d']);
    for (const step of result.data!.personalizedPath) {
      expect(step.reason).toBeTruthy();
    }
  });

  it('已知概念剪枝：已掌握概念不排入路径并记录', async () => {
    const result = await recommendLearningPath({
      graph: buildGraph(),
      profile: { knownConceptIds: ['con-a'] },
    });
    expect(result.data!.learningSequence).not.toContain('con-a');
    expect(result.data!.coverage.skippedKnown).toEqual(['con-a']);
    // 后继仍在（依赖其他先修或作为目标前置）
    expect(result.data!.learningSequence).toContain('con-b');
  });

  it('目标闭包裁剪：目标=神经网络时路径只含其先修链', async () => {
    const result = await recommendLearningPath({
      graph: buildGraph(),
      profile: { goalConceptIds: ['con-d'] },
    });
    const seq = result.data!.learningSequence;
    expect(seq).toContain('con-d');
    expect(seq).toContain('con-b'); // 先修
    expect(seq).toContain('con-a'); // 先修的先修
    expect(seq).not.toContain('con-c'); // 相关但非先修，被裁剪
    expect(seq).not.toContain('sec-a');
    expect(result.data!.coverage.goalsReached).toEqual(['con-d']);
    expect(result.data!.coverage.prunedByGoals).toBeGreaterThan(0);
    // 先修序保持
    expect(seq.indexOf('con-a')).toBeLessThan(seq.indexOf('con-b'));
    expect(seq.indexOf('con-b')).toBeLessThan(seq.indexOf('con-d'));
  });

  it('分钟预算截断：超预算截断并标记', async () => {
    const result = await recommendLearningPath({
      graph: buildGraph(),
      profile: { availableMinutes: 20 },
    });
    // sec-a(10) + sec-b(10) 后预算耗尽，概念步进不去
    expect(result.data!.coverage.truncatedByBudget).toBe(true);
    const total = result.data!.personalizedPath.reduce((s, x) => s + x.minutes, 0);
    expect(total).toBeLessThanOrEqual(20);
  });

  it('mock LLM 生成 reason；垃圾回落模板理由并标 degraded', async () => {
    const ok = await recommendLearningPath(
      { graph: buildGraph(), profile: {} },
      { llm: { complete: async () => JSON.stringify(['第一步：建立整体认识', '第二步：进入优化方法', '第三步：先修基础', '第四步：核心优化', '第五步：扩展任务', '第六步：综合应用']) } },
    );
    expect(ok.level).toBe('full');
    expect(ok.data!.personalizedPath[0].reason).toBe('第一步：建立整体认识');

    const bad = await recommendLearningPath(
      { graph: buildGraph(), profile: {} },
      { llm: { complete: async () => '不是 JSON' } },
    );
    expect(bad.level).toBe('degraded');
    expect(bad.data!.personalizedPath[2].reason).toContain('拓扑');
  });

  it('空图谱 → degraded + 空路径', async () => {
    const empty: CourseKnowledgeGraph = {
      entities: [], relations: [],
      hierarchy: [],
      prerequisiteGraph: { nodes: [], edges: [], topoOrder: [] },
    };
    const result = await recommendLearningPath({ graph: empty, profile: {} });
    expect(result.level).toBe('degraded');
    expect(result.data!.personalizedPath).toEqual([]);
  });

  it('端到端：黄金讲稿链 → 路径非空且满足先修序', async () => {
    const content = readFileSync('tests/fixtures/sample-lecture-ml-basics.md', 'utf8');
    const parsed = await parseCourseMaterial({ content, materialType: 'md' });
    const graph = await extractKnowledgeGraph(parsed.data!);
    const result = await recommendLearningPath({
      graph: graph.data!,
      profile: { availableMinutes: 120 },
    });
    expect(result.data!.personalizedPath.length).toBeGreaterThan(0);
    const pos = new Map(result.data!.learningSequence.map((id, i) => [id, i]));
    for (const e of graph.data!.prerequisiteGraph.edges) {
      if (pos.has(e.from) && pos.has(e.to)) {
        expect(pos.get(e.from)!).toBeLessThan(pos.get(e.to)!);
      }
    }
  }, 20000);
});
