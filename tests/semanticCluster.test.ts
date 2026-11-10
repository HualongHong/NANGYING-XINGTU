import { describe, expect, it, vi } from 'vitest';
import {
  semanticClusterLabels,
  clusterMapping,
  type ClusterItem,
} from '../core/nlp/semanticCluster.js';
import { parseCourseMaterial } from '../core/nlp/parseCourseMaterial.js';
import { extractKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import { fuseKnowledgeGraphs } from '../core/graph/fuseKnowledgeGraphs.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import type { LLMProvider } from '../core/llm.js';

const items = (terms: string[]): ClusterItem[] => terms.map((term, i) => ({ term, freq: terms.length - i }));

function makeGraph(labels: string[]): CourseKnowledgeGraph {
  const entities = labels.map((label, i) => ({
    id: `con-${label}`, kind: 'concept' as const, label, level: 0, order: i,
  }));
  return {
    entities, relations: [], hierarchy: [],
    prerequisiteGraph: { nodes: entities.map((e) => e.id), edges: [], topoOrder: entities.map((e) => e.id) },
  };
}

describe('semanticClusterLabels', () => {
  it('mock LLM：聚类、canonical 映射与词频汇总', async () => {
    const llm: LLMProvider = {
      complete: async () =>
        '[{"canonical":"比色","members":["比色皿","比色杯","比色池"]},{"canonical":"离心","members":["离心操作"]}]',
    };
    const r = await semanticClusterLabels(items(['比色皿', '比色杯', '比色池', '离心操作', '电泳']), { llm });
    expect(r.level).toBe('full');
    const map = clusterMapping(r.data!.clusters);
    expect(map.get('比色皿')).toBe('比色');
    expect(map.get('离心操作')).toBe('离心');
    expect(map.get('电泳')).toBeUndefined(); // 未在簇中
    const cuvette = r.data!.clusters.find((c) => c.canonical === '比色')!;
    expect(cuvette.members).toHaveLength(3);
    expect(cuvette.totalFreq).toBeGreaterThan(0);
  });

  it('分批：>100 标签分多批调用，canonical 归一化相等并簇', async () => {
    const terms = Array.from({ length: 150 }, (_, i) => `术语${i}号`);
    const calls: string[] = [];
    const llm: LLMProvider = {
      complete: async (prompt: string) => {
        calls.push(prompt);
        // 各批成员归到同一 canonical（模拟跨批同义）
        const batchTerms: string[] = JSON.parse(prompt.slice(prompt.lastIndexOf('[')));
        return JSON.stringify([{ canonical: '同义词', members: batchTerms }]);
      },
    };
    const r = await semanticClusterLabels(items(terms), { llm });
    expect(calls).toHaveLength(2);
    expect(r.data!.clusters).toHaveLength(1); // 归一化 canonical 并簇
    expect(r.data!.clusters[0].members).toHaveLength(150);
    const expectedTotal = (150 * 151) / 2; // 1..150 词频和
    expect(r.data!.clusters[0].totalFreq).toBe(expectedTotal);
  });

  it('非法 JSON：该批跳过并整体标 degraded，不抛异常', async () => {
    let n = 0;
    const llm: LLMProvider = {
      complete: async () => (n++ === 0 ? '垃圾返回' : '[{"canonical":"乙","members":["甲"]}]'),
    };
    const r = await semanticClusterLabels(items(['甲', '乙', '丙', '丁']), { llm }, { batchSize: 2 });
    expect(r.level).toBe('degraded');
    expect(r.degradationNote).toContain('第 1 批');
    expect(r.data!.clusters).toHaveLength(1); // 第二批成果保留
  });

  it('未注入 LLM：空聚类 + degraded', async () => {
    const r = await semanticClusterLabels(items(['甲']));
    expect(r.level).toBe('degraded');
    expect(r.data!.clusters).toEqual([]);
  });
});

describe('extract/fuse 语义聚类接入', () => {
  const BIOCHEM_TEXT = [
    '比色皿用于分光光度测定，比色皿需要保持清洁。',
    '比色杯与比色皿类似，比色杯使用前后要清洗。',
    '比色池也是盛放待测液的器皿，比色池需避光。',
    '离心操作分离细胞组分，离心操作依赖转速。',
    '离心操作需要平衡配管，离心操作后取上清。',
    '离心是常用的分离手段，离心的转速决定效果。',
  ].join('\n\n');

  it('端到端：比色皿/比色杯/比色池 mock 聚成"比色"簇后建图归并', async () => {
    const parsed = await parseCourseMaterial({ content: BIOCHEM_TEXT, materialType: 'txt' });
    const llm: LLMProvider = {
      complete: async () =>
        '[{"canonical":"比色","members":["比色皿","比色杯","比色池"]}]',
    };
    const withCluster = await extractKnowledgeGraph(parsed.data!, { llm }, { semanticClustering: true });
    const labels = withCluster.data!.entities.map((e) => e.label);
    expect(labels).toContain('比色');
    expect(labels).not.toContain('比色皿');
    expect(labels).not.toContain('比色杯');
    // 离心不参与聚类，保持原样
    expect(labels.some((l) => l.includes('离心'))).toBe(true);
  });

  it('默认关闭不改变现有输出（开启前后无 LLM 时结果一致）', async () => {
    const parsed = await parseCourseMaterial({ content: BIOCHEM_TEXT, materialType: 'txt' });
    const baseline = await extractKnowledgeGraph(parsed.data!);
    const off = await extractKnowledgeGraph(parsed.data!, {}, { semanticClustering: false });
    expect(JSON.stringify(off.data)).toBe(JSON.stringify(baseline.data));
    // 开启但无 LLM → 与基线一致（空聚类不改变候选）
    const noLlm = await extractKnowledgeGraph(parsed.data!, {}, { semanticClustering: true });
    expect(JSON.stringify(noLlm.data)).toBe(JSON.stringify(baseline.data));
  });

  it('fuse 开启语义聚类：跨来源近义标签归并到 canonical', async () => {
    const g1 = makeGraph(['比色皿', '淀粉']);
    const g2 = makeGraph(['比色杯', '还原糖']);
    const spy = vi.fn(async () => '[{"canonical":"比色","members":["比色皿","比色杯"]}]');
    const r = await fuseKnowledgeGraphs(
      { graphs: [g1, g2], sources: [{ id: 'a' }, { id: 'b' }] },
      { llm: { complete: spy } },
      { semanticClustering: true },
    );
    expect(spy).toHaveBeenCalled();
    const labels = r.data!.graph.entities.map((e) => e.label);
    expect(labels).toContain('比色');
    expect(labels).not.toContain('比色皿');
    expect(labels).not.toContain('比色杯');
  });
});
