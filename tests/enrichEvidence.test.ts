import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import {
  planEvidenceQueries,
  mergeEvidence,
  evidenceStats,
  MAX_EVIDENCE_QUERIES,
} from '../core/evidence/enrichEvidence.js';

// 可编程 mock：state.mode 控制 SciVerse 服务可用性（不触网）
const state = { mode: 'nokey' as 'nokey' | 'ok' | 'partial' };
const calls: Array<{ method: string; query: string }> = [];
vi.mock('../adapters/odlab/sciverse.js', () => ({
  createSciverseService: async () => {
    if (state.mode === 'nokey') {
      return { ok: false, reason: '未配置 SciVerse API Token（settings_card 平台服务区块或 SCIVERSE_API_TOKEN）' };
    }
    return {
      ok: true,
      service: {
        semanticSearch: async ({ query }: { query: string }) => {
          calls.push({ method: 'semanticSearch', query });
          if (state.mode === 'partial' && query === '失败词') throw new Error('Sciverse API 429');
          return [{ title: `关于${query}的研究`, snippet: '证据片段内容', docId: 'doc-1', score: 0.9, source: 'sciverse' as const }];
        },
        searchMetadata: async ({ query }: { query: string }) => {
          calls.push({ method: 'searchMetadata', query });
          return [{ title: `元数据-${query}`, venue: 'Test Journal', year: 2024, doi: '10.0000/demo', uniqueId: 'u-1', source: 'sciverse' as const }];
        },
      },
    };
  },
}));

const GRAPH = {
  entities: [
    { id: 'n1', kind: 'concept', label: '光合作用' },
    { id: 'n2', kind: 'concept', label: '卡尔文循环' },
    { id: 'c1', kind: 'chapter', label: '第三章 代谢' },
  ],
  relations: [],
};

beforeEach(() => {
  state.mode = 'nokey';
  calls.length = 0;
  delete process.env.SCIVERSE_API_TOKEN;
});

describe('学术证据核心（core/evidence/enrichEvidence.ts）', () => {
  it('planEvidenceQueries：graph 取 concept 节点 label；queries 直通；topK/mode 校验', () => {
    const g = planEvidenceQueries({ graph: GRAPH });
    expect(g).toMatchObject({ ok: true, topK: 3, mode: 'agentic' });
    if (g.ok) {
      expect(g.queries).toEqual([
        { entityId: 'n1', query: '光合作用' },
        { entityId: 'n2', query: '卡尔文循环' },
      ]);
    }
    const q = planEvidenceQueries({ queries: ['知识图谱'], topK: 5, mode: 'meta' });
    expect(q).toMatchObject({ ok: true, topK: 5, mode: 'meta' });
    if (q.ok) expect(q.queries).toEqual([{ entityId: '知识图谱', query: '知识图谱' }]);
    // 校验失败族
    expect(planEvidenceQueries({})).toHaveProperty('error');
    expect(planEvidenceQueries({ topK: 99, queries: ['x'] })).toHaveProperty('error');
    expect(planEvidenceQueries({ topK: 0, queries: ['x'] })).toHaveProperty('error');
    expect(planEvidenceQueries({ queries: [] })).toHaveProperty('error');
    expect(planEvidenceQueries({ queries: ['ok', 42] })).toHaveProperty('error');
    expect(planEvidenceQueries({ graph: { entities: [{ id: 'c', kind: 'chapter', label: '章' }] } })).toHaveProperty('error');
    expect(planEvidenceQueries({ graph: { nope: 1 } })).toHaveProperty('error');
  });

  it('planEvidenceQueries：查询数超上限截断', () => {
    const many = Array.from({ length: MAX_EVIDENCE_QUERIES + 5 }, (_, i) => `q${i}`);
    const p = planEvidenceQueries({ queries: many });
    expect(p.ok && p.queries.length).toBe(MAX_EVIDENCE_QUERIES);
  });

  it('mergeEvidence/evidenceStats：不可变合并与统计', () => {
    const graph = { entities: [1] };
    const out = mergeEvidence(graph, [
      { entityId: 'a', query: 'a', references: [{ title: 't', source: 'sciverse' }] },
      { entityId: 'b', query: 'b', references: [] },
    ]);
    expect(out.entities).toEqual([1]);
    expect(out.academicEvidence).toHaveLength(2);
    expect(graph).not.toHaveProperty('academicEvidence');
    expect(evidenceStats(out.academicEvidence)).toEqual({
      entitiesQueried: 2,
      entitiesWithReferences: 1,
      totalReferences: 1,
    });
  });
});

describe('学术证据技能（enrich_knowledge_evidence 执行器）', () => {
  it('平台不可用（无 Token）：degraded + 原图谱不动 + 空证据 + 补齐路径', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('enrich_knowledge_evidence', {
      inputs: { graph: GRAPH },
    });
    expect(r.level).toBe('degraded');
    const d = r.data as { entities: unknown[]; academicEvidence: unknown[]; platformNote: string };
    expect(d.entities).toHaveLength(3);
    expect(d.academicEvidence).toEqual([]);
    expect(d.platformNote).toContain('配置后重跑');
  });

  it('full：graph 逐概念检索并合并 academicEvidence + stats', async () => {
    state.mode = 'ok';
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('enrich_knowledge_evidence', {
      inputs: { graph: GRAPH, topK: 3 },
    });
    expect(r.level).toBe('full');
    const d = r.data as {
      academicEvidence: Array<{ entityId: string; references: Array<{ title: string; snippet?: string }> }>;
      stats: { entitiesQueried: number; entitiesWithReferences: number; totalReferences: number };
      mode: string;
    };
    expect(d.mode).toBe('agentic');
    expect(d.academicEvidence.map((e) => e.entityId)).toEqual(['n1', 'n2']);
    expect(d.academicEvidence[0].references[0].title).toContain('光合作用');
    expect(d.academicEvidence[0].references[0].snippet).toBe('证据片段内容');
    expect(d.stats).toEqual({ entitiesQueried: 2, entitiesWithReferences: 2, totalReferences: 2 });
    expect(calls.every((c) => c.method === 'semanticSearch')).toBe(true);
  });

  it('meta 模式：走 searchMetadata 并回传 venue/year/doi', async () => {
    state.mode = 'ok';
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('enrich_knowledge_evidence', {
      inputs: { queries: ['慕课'], mode: 'meta' },
    });
    expect(r.level).toBe('full');
    const d = r.data as {
      queries: string[];
      academicEvidence: Array<{ references: Array<{ venue?: string; year?: number; doi?: string }> }>;
    };
    expect(d.queries).toEqual(['慕课']);
    expect(calls[0].method).toBe('searchMetadata');
    expect(d.academicEvidence[0].references[0]).toMatchObject({ venue: 'Test Journal', year: 2024, doi: '10.0000/demo' });
  });

  it('部分实体检索失败：degraded + 失败实体空证据 + degradationNote 可重跑补齐', async () => {
    state.mode = 'partial';
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('enrich_knowledge_evidence', {
      inputs: { queries: ['正常词', '失败词'] },
    });
    expect(r.level).toBe('degraded');
    expect(r.degradationNote).toContain('失败词');
    const d = r.data as { academicEvidence: Array<{ references: unknown[] }> };
    expect(d.academicEvidence[0].references).toHaveLength(1);
    expect(d.academicEvidence[1].references).toHaveLength(0);
  });

  it('非法输入：INVALID_INPUT（graph/queries 都缺、topK 越界）', async () => {
    const adapter = new LocalAdapter();
    for (const inputs of [{}, { topK: 20, queries: ['x'] }, { graph: 'not-object' }]) {
      const r = await adapter.invokeSkill('enrich_knowledge_evidence', { inputs });
      expect(r.level).toBe('unavailable');
      expect(r.errorCode).toBe('INVALID_INPUT');
    }
  });
});
