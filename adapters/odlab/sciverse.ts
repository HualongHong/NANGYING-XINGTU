/**
 * SciVerse（OpenDataLab 学术基座）服务包装：官方 `sciverse` npm SDK（optionalDependencies，
 * 动态 import；未安装=服务不可用，优雅降级）+ 响应归一化为 core/evidence 内部 schema。
 * 密钥经 keyProvider 惰性注入（SDK 推荐的 vault 模式：显式传 token）；
 * 本机 .env 的 SCIVERSE_API_TOKEN 为 SDK 原生调试通道（AgentToolsClient 自动回退）。
 * 扩展位：readContent / getResource / listPaperRelations 后续按需开放（见 README 平台矩阵）。
 */
import type { EvidenceReference } from '../../core/evidence/enrichEvidence.js';

export interface SciverseService {
  /** 语义证据段检索（agentic-search；mode=fast/balanced/quality） */
  semanticSearch(args: { query: string; topK: number; mode: 'fast' | 'balanced' | 'quality' }): Promise<EvidenceReference[]>;
  /** 元数据检索（meta-search；返回 venue/year/doi 等书目字段） */
  searchMetadata(args: { query: string; topK: number }): Promise<EvidenceReference[]>;
}

export type SciverseServiceResult =
  | { ok: true; service: SciverseService }
  | { ok: false; reason: string };

type SemanticHit = {
  doc_id?: string; title?: string; abstract?: string; chunk?: string; score?: number;
};
type MetaHit = {
  unique_id?: string; doc_id?: string; title?: string; abstract?: string;
  publication_venue_name_unified?: string; publication_published_year?: number; doi?: string;
};

/**
 * 创建 SciVerse 服务。无密钥或 SDK 不可用时返回 { ok:false, reason }——
 * 调用方据 reason 输出 degraded（平台不可用≠流程中断）。
 */
export async function createSciverseService(opts: {
  keyProvider: () => string | undefined;
  baseUrl?: string;
}): Promise<SciverseServiceResult> {
  const key = opts.keyProvider()?.trim();
  if (!key) {
    return { ok: false, reason: '未配置 SciVerse API Token（settings_card 平台服务区块或 SCIVERSE_API_TOKEN）' };
  }
  let mod: typeof import('sciverse');
  try {
    mod = await import('sciverse');
  } catch {
    return { ok: false, reason: '官方 sciverse SDK 未安装（optionalDependencies 缺装）；pnpm install 后重试' };
  }
  const client = new mod.AgentToolsClient({ token: key, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });
  return {
    ok: true,
    service: {
      async semanticSearch({ query, topK, mode }) {
        const resp = (await client.semanticSearch({ query, top_k: topK, mode })) as { hits?: SemanticHit[] };
        return (resp.hits ?? []).map((h) => ({
          title: h.title ?? '',
          snippet: h.chunk ?? h.abstract,
          docId: h.doc_id,
          score: h.score,
          source: 'sciverse' as const,
        }));
      },
      async searchMetadata({ query, topK }) {
        const resp = (await client.searchMetadata({ query, page_size: topK })) as { results?: MetaHit[] };
        return (resp.results ?? []).map((h) => ({
          title: h.title ?? '',
          snippet: h.abstract,
          docId: h.doc_id,
          uniqueId: h.unique_id,
          venue: h.publication_venue_name_unified,
          year: h.publication_published_year,
          doi: h.doi,
          source: 'sciverse' as const,
        }));
      },
    },
  };
}
