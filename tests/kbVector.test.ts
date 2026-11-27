import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVectorIndex, cosineSimilarity, queryVectorIndex } from '../core/kb/kbVectorIndex.js';
import { buildTeachingKnowledgeBase } from '../core/kb/buildTeachingKnowledgeBase.js';
import type { EmbedderProvider } from '../core/llm.js';
import type { ParseCourseMaterialOutput } from '../core/nlp/parseCourseMaterial.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

/** 确定性假 embedder：4 维向量由文本特征派生（同文本同向量） */
function fakeEmbedder(model = 'fake-emb-v1'): EmbedderProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model,
    dim: 4,
    calls,
    async embed(texts: string[]) {
      calls.push(texts);
      return texts.map((t) => {
        let h = 0;
        for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
        return [(t.length % 7) + 1, (h % 5) + 1, (h % 3) + 1, 1];
      });
    },
  };
}

const EVIDENCE = [
  { id: 'ev-a', text: '光合作用分为光反应和碳反应。', origin: 'corpus' as const, materialId: 'm1', sectionOrder: 0, paragraphIndexes: [0], citation: {}, conceptIds: [], tokenCount: 8 },
  { id: 'ev-b', text: '光反应产生 ATP。', origin: 'corpus' as const, materialId: 'm1', sectionOrder: 0, paragraphIndexes: [1], citation: {}, conceptIds: [], tokenCount: 5 },
];

describe('kbVectorIndex：构建/缓存/召回', () => {
  it('cosineSimilarity：同向=1、正交=0、零向量=0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('构建：条目按 id 排序、dim/count 正确、批量分批', async () => {
    const emb = fakeEmbedder();
    const r = await buildVectorIndex([EVIDENCE[1], EVIDENCE[0]], emb, { batchSize: 1 });
    expect(r.index.entries.map(([id]) => id)).toEqual(['ev-a', 'ev-b']);
    expect(r.index.dim).toBe(4);
    expect(r.index.count).toBe(2);
    expect(r.embedded).toBe(2);
    expect(emb.calls.length).toBe(2); // batchSize=1 → 两批
  });

  it('缓存复用：同文本同模型 reused 全部；改文本只重嵌该条；换模型全量重嵌', async () => {
    const emb = fakeEmbedder();
    const first = await buildVectorIndex(EVIDENCE, emb, {});
    const second = await buildVectorIndex(EVIDENCE, emb, { previous: first.index });
    expect(second.reused).toBe(2);
    expect(second.embedded).toBe(0);
    const changed = [{ ...EVIDENCE[0], text: '光合作用分为三个阶段。' }, EVIDENCE[1]];
    const third = await buildVectorIndex(changed, emb, { previous: first.index });
    expect(third.reused).toBe(1);
    expect(third.embedded).toBe(1);
    const newModel = await buildVectorIndex(EVIDENCE, fakeEmbedder('fake-emb-v2'), { previous: first.index });
    expect(newModel.reused).toBe(0);
    expect(newModel.embedded).toBe(2);
  });

  it('维度不一致抛错（防混模型）；数量不符抛错', async () => {
    // 同模型（缓存保留 prev.dim=4）但返回 2 维 → 维度不一致
    const bad: EmbedderProvider = { model: 'fake-emb-v1', async embed(texts) { return texts.map(() => [1, 2]); } };
    const first = await buildVectorIndex(EVIDENCE, fakeEmbedder(), {});
    await expect(buildVectorIndex([{ ...EVIDENCE[0], text: '新文本' }], bad, { previous: first.index })).rejects.toThrow('维度不一致');
    // 同批内维度漂移也拦截
    let call = 0;
    const drift: EmbedderProvider = { async embed(texts) { return texts.map(() => (call++ === 0 ? [1, 2, 3] : [1, 2])); } };
    await expect(buildVectorIndex(EVIDENCE, drift, { batchSize: 1 })).rejects.toThrow('维度不一致');
    const badCount: EmbedderProvider = { async embed() { return [[1, 2, 3, 4]]; } };
    await expect(buildVectorIndex(EVIDENCE, badCount, {})).rejects.toThrow('数量不符');
  });

  it('queryVectorIndex：正余弦 top 排序；维度不符抛错含重建提示', async () => {
    const emb = fakeEmbedder();
    const { index } = await buildVectorIndex(EVIDENCE, emb, {});
    const [q] = await emb.embed(['光合作用分为光反应和碳反应。']);
    const scores = queryVectorIndex(index, q);
    expect(scores.get('ev-a')).toBeCloseTo(1);
    expect(() => queryVectorIndex(index, [1, 2])).toThrow('重建知识库');
  });
});

function parseOf(texts: string[]): ParseCourseMaterialOutput {
  return {
    structuredSections: [{ title: '第一章', level: 1, order: 0 }],
    paragraphs: texts.map((text, index) => ({ index, text, sectionOrder: 0 })),
    tables: [],
    knowledgePointCandidates: [],
    llmFilterReport: { enabled: false } as never,
  };
}

function graphOf(): CourseKnowledgeGraph {
  return {
    schemaVersion: '1.2',
    entities: [
      { id: 'con-b', kind: 'concept', label: '光反应', level: 0, order: 0, confidence: 0.8, source: { sectionOrder: [0], paragraphIndexes: [0, 1] } },
    ],
    relations: [],
    hierarchy: [],
    prerequisiteGraph: { nodes: [], edges: [], topoOrder: [] },
  };
}

describe('build/query 执行器向量集成（显式注入 embedder）', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('build：embedder 在场构建向量索引并诚实报告；query 融合向量得分', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nangying-kbv-'));
    process.env.NANGYING_CONFIG_DIR = dir;
    try {
      const adapter = new LocalAdapter({ embedder: fakeEmbedder() });
      const built = await adapter.invokeSkill('build_teaching_knowledge_base', {
        inputs: { materials: [{ materialId: 'm1', parse: parseOf(['光反应在类囊体膜上进行。', '碳反应固定二氧化碳。']) }], graph: graphOf() },
      });
      expect(built.level).toBe('full');
      expect(built.degradationNote).toContain('向量索引 2 条');
      const kb = (built.data as { knowledgeBase: { indexes: { vector: { count: number } | null } } }).knowledgeBase;
      expect(kb.indexes.vector!.count).toBe(2);

      const queried = await adapter.invokeSkill('query_teaching_knowledge_base', {
        inputs: { kb, query: '类囊体膜 光反应' },
      });
      expect(queried.level).toBe('full');
      const pack = (queried.data as { evidencePack: { stats: { vectorHits: number }; items: Array<{ scoreParts: { vector: number } }> } }).evidencePack;
      expect(pack.stats.vectorHits).toBeGreaterThan(0);
      expect(pack.items.some((i) => i.scoreParts.vector > 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('增量缓存：二次构建复用向量（复用 2、新嵌入 0）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nangying-kbv-'));
    process.env.NANGYING_CONFIG_DIR = dir;
    try {
      const adapter = new LocalAdapter({ embedder: fakeEmbedder() });
      const inputs = { materials: [{ materialId: 'm1', parse: parseOf(['光反应在类囊体膜上进行。', '碳反应固定二氧化碳。']) }], graph: graphOf() };
      await adapter.invokeSkill('build_teaching_knowledge_base', { inputs });
      const again = await adapter.invokeSkill('build_teaching_knowledge_base', { inputs });
      expect(again.degradationNote).toContain('复用 2、新嵌入 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('降级：build 时 embedder 抛错 → degraded + 纯倒排可用；query 时抛错 → 降级标注且倒排结果仍在', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nangying-kbv-'));
    process.env.NANGYING_CONFIG_DIR = dir;
    try {
      const broken: EmbedderProvider = { async embed() { throw new Error('endpoint down'); } };
      const adapter = new LocalAdapter({ embedder: broken });
      const built = await adapter.invokeSkill('build_teaching_knowledge_base', {
        inputs: { materials: [{ materialId: 'm1', parse: parseOf(['光反应在类囊体膜上进行。']) }], graph: graphOf() },
      });
      expect(built.level).toBe('degraded');
      expect(built.degradationNote).toContain('已降级纯倒排');
      const kb = (built.data as { knowledgeBase: { indexes: { vector: unknown } } }).knowledgeBase;
      expect(kb.indexes.vector).toBeNull();

      // query：kb 有向量索引但 embedder 抛错
      const goodAdapter = new LocalAdapter({ embedder: fakeEmbedder() });
      const good = await goodAdapter.invokeSkill('build_teaching_knowledge_base', {
        inputs: { materials: [{ materialId: 'm1', parse: parseOf(['光反应在类囊体膜上进行。']) }], graph: graphOf(), persist: false },
      });
      const kbWithVec = (good.data as { knowledgeBase: unknown }).knowledgeBase;
      const q = await adapter.invokeSkill('query_teaching_knowledge_base', { inputs: { kb: kbWithVec, query: '光反应' } });
      expect(q.degradationNote).toContain('向量召回失败，已降级纯倒排');
      const pack = (q.data as { evidencePack: { items: unknown[] } }).evidencePack;
      expect(pack.items.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kb 含向量索引但宿主未注入 embedder → 诚实标注纯倒排', async () => {
    const goodAdapter = new LocalAdapter({ embedder: fakeEmbedder() });
    const good = await goodAdapter.invokeSkill('build_teaching_knowledge_base', {
      inputs: { materials: [{ materialId: 'm1', parse: parseOf(['光反应在类囊体膜上进行。']) }], graph: graphOf(), persist: false },
    });
    const kb = (good.data as { knowledgeBase: unknown }).knowledgeBase;
    const plain = new LocalAdapter();
    const q = await plain.invokeSkill('query_teaching_knowledge_base', { inputs: { kb, query: '光反应' } });
    expect(q.degradationNote).toContain('未注入 embedder');
    expect(q.level).toBe('full');
  });
});
