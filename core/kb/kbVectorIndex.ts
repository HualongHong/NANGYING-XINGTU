/**
 * KB 向量索引（KAG-1 R24，可选增强位）：纯 TS Float 余弦，零外部依赖。
 * embedder 经 SkillContext 宿主注入；缺席/失败由调用方降级为纯倒排。
 * 增量重建缓存：同 evidenceId + 同文本哈希 + 同模型 → 复用旧向量（大语料重建省时）。
 */
import type { EmbedderProvider } from '../llm.js';
import type { KbEvidence, KbIndexes } from './kbTypes.js';

export type KbVectorIndex = NonNullable<KbIndexes['vector']>;

function textHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface BuildVectorIndexResult {
  index: KbVectorIndex;
  /** 复用缓存条数 / 新嵌入条数（诚实报告） */
  reused: number;
  embedded: number;
}

/** 构建向量索引：批量嵌入 + 缓存复用；返回条目按 evidenceId 排序（确定性序列化） */
export async function buildVectorIndex(
  evidence: KbEvidence[],
  embedder: EmbedderProvider,
  opts: { batchSize?: number; previous?: KbVectorIndex | null } = {},
): Promise<BuildVectorIndexResult> {
  const batchSize = Math.max(1, opts.batchSize ?? 32);
  const prev = opts.previous && opts.previous.model === embedder.model ? opts.previous : null;
  const prevById = new Map(prev?.entries ?? []);
  const prevHashes = prev?.textHashes ?? {};

  const hashes: Record<string, string> = {};
  const entries: Array<[string, number[]]> = [];
  const toEmbed: KbEvidence[] = [];
  let reused = 0;
  for (const ev of evidence) {
    const h = textHash(ev.text);
    hashes[ev.id] = h;
    const cached = prevById.get(ev.id);
    if (cached && prevHashes[ev.id] === h) {
      entries.push([ev.id, cached]);
      reused += 1;
    } else {
      toEmbed.push(ev);
    }
  }

  let dim = prev?.dim ?? embedder.dim ?? 0;
  for (let i = 0; i < toEmbed.length; i += batchSize) {
    const batch = toEmbed.slice(i, i + batchSize);
    const vecs = await embedder.embed(batch.map((e) => e.text));
    if (!Array.isArray(vecs) || vecs.length !== batch.length) {
      throw new Error(`embedder 返回数量不符：期望 ${batch.length}，实得 ${Array.isArray(vecs) ? vecs.length : typeof vecs}`);
    }
    for (let j = 0; j < batch.length; j++) {
      const v = vecs[j];
      if (!Array.isArray(v) || v.length === 0) throw new Error(`embedder 返回空向量：${batch[j].id}`);
      if (dim === 0) dim = v.length;
      if (v.length !== dim) throw new Error(`embedder 向量维度不一致：期望 ${dim}，实得 ${v.length}（${batch[j].id}）`);
      entries.push([batch[j].id, v]);
    }
  }

  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return {
    index: {
      dim,
      count: entries.length,
      ...(embedder.model ? { model: embedder.model } : {}),
      entries,
      textHashes: hashes,
    },
    reused,
    embedded: toEmbed.length,
  };
}

/** 向量召回：query 向量 × 索引余弦，取得分 >0 的 top maxResults（确定性 tie-break） */
export function queryVectorIndex(
  index: KbVectorIndex,
  queryVec: number[],
  opts: { maxResults?: number } = {},
): Map<string, number> {
  const maxResults = opts.maxResults ?? 20;
  if (queryVec.length !== index.dim) {
    throw new Error(`查询向量维度 ${queryVec.length} 与索引维度 ${index.dim} 不符（嵌入模型可能已更换，请重建知识库）`);
  }
  const scored: Array<[string, number]> = [];
  for (const [evId, vec] of index.entries) {
    const s = cosineSimilarity(queryVec, vec);
    if (s > 0) scored.push([evId, s]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return new Map(scored.slice(0, maxResults));
}
