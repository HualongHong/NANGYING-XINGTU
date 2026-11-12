/**
 * 学术证据增强（enrich_knowledge_evidence）核心：纯函数，零 IO。
 * 查询规划（graph/queries 二选一、topK/mode 校验）与结果归并均为确定性实现；
 * SciVerse 网络访问由适配层 adapters/odlab/sciverse.ts 完成。
 *
 * 独立性：本模块不依赖平台可用——调用方在平台不可用时应原样回传输入并标注 degraded。
 */

/** 归一化后的单条学术引用（源自 SciVerse SDK 响应，字段防御性可选） */
export interface EvidenceReference {
  title: string;
  /** 证据片段（agentic=语义段；meta=摘要） */
  snippet?: string;
  /** 全文 artifact 哈希（read_content 取正文用） */
  docId?: string;
  /** 元数据记录全局 ID（引用/去重用） */
  uniqueId?: string;
  score?: number;
  venue?: string;
  year?: number;
  doi?: string;
  source: 'sciverse';
}

export interface EntityEvidence {
  entityId: string;
  query: string;
  references: EvidenceReference[];
}

export interface EvidenceEnrichmentInput {
  graph?: unknown;
  queries?: unknown;
  topK?: unknown;
  mode?: unknown;
}

export type EvidenceMode = 'agentic' | 'meta';

export type EvidencePlan =
  | { ok: true; queries: Array<{ entityId: string; query: string }>; topK: number; mode: EvidenceMode }
  | { ok: false; error: string };

/** 单次调用查询数上限（平台额度保护；超限截断并在 note 说明） */
export const MAX_EVIDENCE_QUERIES = 20;

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * 规划证据查询：graph 与 queries 二选一（graph 优先）。
 * graph：取 entities 中 kind==='concept' 节点的 label 作为查询词；
 * topK 默认 3，钳制 1-10；mode 仅 agentic|meta。
 */
export function planEvidenceQueries(input: EvidenceEnrichmentInput): EvidencePlan {
  const mode: EvidenceMode = input.mode === 'meta' ? 'meta' : 'agentic';

  const topKRaw = input.topK === undefined ? 3 : Number(input.topK);
  if (!Number.isInteger(topKRaw) || topKRaw < 1 || topKRaw > 10) {
    return { ok: false, error: `topK 须为 1-10 整数：${String(input.topK)}` };
  }
  const topK = topKRaw;

  const pairs: Array<{ entityId: string; query: string }> = [];
  if (input.graph !== undefined) {
    if (!isObj(input.graph) || !Array.isArray(input.graph.entities)) {
      return { ok: false, error: 'graph 须为含 entities 数组的图谱对象（extract_knowledge_graph / fuse_knowledge_graphs 输出）' };
    }
    for (const e of input.graph.entities as unknown[]) {
      if (!isObj(e)) continue;
      const kind = typeof e.kind === 'string' ? e.kind : 'concept';
      const label = typeof e.label === 'string' ? e.label.trim() : '';
      const id = typeof e.id === 'string' && e.id ? e.id : label;
      if (kind === 'concept' && label) pairs.push({ entityId: id, query: label });
    }
    if (pairs.length === 0) {
      return { ok: false, error: 'graph.entities 中没有概念节点（kind="concept"），无法生成学术查询' };
    }
  } else if (input.queries !== undefined) {
    if (!Array.isArray(input.queries) || input.queries.length === 0) {
      return { ok: false, error: 'queries 须为非空字符串数组' };
    }
    for (const q of input.queries) {
      if (typeof q !== 'string' || q.trim() === '') {
        return { ok: false, error: 'queries 元素须为非空字符串' };
      }
      pairs.push({ entityId: q.trim(), query: q.trim() });
    }
  } else {
    return { ok: false, error: 'graph 与 queries 须二选一：graph=课程图谱（推荐），queries=自定义查询词数组' };
  }

  const trimmed = pairs.slice(0, MAX_EVIDENCE_QUERIES);
  return { ok: true, queries: trimmed, topK, mode };
}

/** 不可变合并：把证据挂到图谱上（原 graph 字段全部保留） */
export function mergeEvidence<T>(graph: T, evidences: EntityEvidence[]): T & { academicEvidence: EntityEvidence[] } {
  return { ...(graph as object), academicEvidence: evidences } as T & { academicEvidence: EntityEvidence[] };
}

/** 汇总统计（status/摘要用） */
export function evidenceStats(evidences: EntityEvidence[]): {
  entitiesQueried: number;
  entitiesWithReferences: number;
  totalReferences: number;
} {
  return {
    entitiesQueried: evidences.length,
    entitiesWithReferences: evidences.filter((e) => e.references.length > 0).length,
    totalReferences: evidences.reduce((n, e) => n + e.references.length, 0),
  };
}
