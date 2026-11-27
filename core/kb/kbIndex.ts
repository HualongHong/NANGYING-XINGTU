/**
 * KB 索引层：倒排索引（复用 qa 分词口径）+ 概念邻接表。
 * 全部纯 TS、可 JSON 序列化；向量索引为 R24 可选位（本文件不含）。
 */
import { tokenize } from '../qa/buildQaKnowledgeBase.js';
import type { KnowledgeGraphEdge } from '../graph/extractKnowledgeGraph.js';
import type { KbAdjacency, KbEvidence, KbInvertedIndex } from './kbTypes.js';

/** 构建倒排索引：term → [evidenceId, 词频权重][]（确定性排序：权重降序、id 升序） */
export function buildInvertedIndex(evidence: KbEvidence[]): KbInvertedIndex {
  const terms = new Map<string, Map<string, number>>();
  for (const ev of evidence) {
    const counts = new Map<string, number>();
    for (const t of tokenize(ev.text)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const [t, c] of counts) {
      const bucket = terms.get(t) ?? new Map<string, number>();
      bucket.set(ev.id, c);
      terms.set(t, bucket);
    }
  }
  const out: KbInvertedIndex['terms'] = {};
  for (const t of [...terms.keys()].sort()) {
    out[t] = [...terms.get(t)!.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
  return { terms: out };
}

/** 倒排召回：query 分词 → 权重求和（同 qa search 口径），返回 evId → 得分 */
export function queryInvertedIndex(index: KbInvertedIndex, query: string): Map<string, number> {
  const scores = new Map<string, number>();
  for (const t of new Set(tokenize(query))) {
    for (const [evId, w] of index.terms[t] ?? []) {
      scores.set(evId, (scores.get(evId) ?? 0) + w);
    }
  }
  return scores;
}

/** 概念邻接表：related/prerequisite 边双向登记（graphExpand 一阶扩展用） */
export function buildAdjacency(relations: KnowledgeGraphEdge[]): KbAdjacency {
  const adj: KbAdjacency = {};
  const push = (from: string, to: string, type: string, direction: 'out' | 'in') => {
    (adj[from] ??= []).push({ to, type, direction });
  };
  for (const e of relations) {
    if (e.type !== 'related' && e.type !== 'prerequisite') continue;
    push(e.from, e.to, e.type, 'out');
    push(e.to, e.from, e.type, 'in');
  }
  for (const k of Object.keys(adj)) {
    adj[k].sort((a, b) => a.to.localeCompare(b.to) || a.type.localeCompare(b.type));
  }
  return adj;
}

/** 一阶邻域（确定性排序去重） */
export function neighborsOf(adjacency: KbAdjacency, conceptId: string): Array<{ to: string; type: string; direction: 'out' | 'in' }> {
  return adjacency[conceptId] ?? [];
}
