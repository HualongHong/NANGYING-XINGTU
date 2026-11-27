/**
 * KB 统一检索（KAG 式五段管线，SPEC §4.2）：
 * Recall（倒排∪向量[R24 接口位]）→ GraphExpand（概念邻域一阶）→ FuseRank（确定性融合）
 * → Budget（token 预算裁剪）→ GapReport（命中稀薄诚实出口）。
 * 纯函数零 IO；同输入同输出（排序均带 id tie-break）。
 */
import { normalizeLabel } from '../graph/diffKnowledgeGraphs.js';
import { KB_LIMITS } from './kbSchema.js';
import { neighborsOf, queryInvertedIndex } from './kbIndex.js';
import type { EvidencePack, EvidencePackItem, TeachingKnowledgeBase } from './kbTypes.js';

export interface KbRetrieveOptions {
  topK?: number;
  budgetTokens?: number;
  /** 图谱扩展开关（默认 true） */
  expand?: boolean;
  /** 向量得分（R24 embedder 注入后由调用方预算；缺席=纯倒排） */
  vectorScores?: Map<string, number>;
}

/** 融合权重（确定性常数；改动即行为变更，须过 golden 集回归） */
export const FUSE_WEIGHTS = {
  vector: 2,
  graphBase: 1,
  graphDistanceDecay: 0.5,
  confidence: 0.2,
} as const;

export function kbRetrieve(kb: TeachingKnowledgeBase, query: string, opts: KbRetrieveOptions = {}): EvidencePack {
  const topK = opts.topK ?? KB_LIMITS.defaultTopK;
  const budget = opts.budgetTokens ?? KB_LIMITS.defaultBudgetTokens;
  const expand = opts.expand !== false;

  const evById = new Map(kb.evidence.map((e) => [e.id, e]));
  const conceptById = new Map(kb.concepts.map((c) => [c.id, c]));

  // ① Recall：倒排（必在）∪ 向量（可选）
  const invScores = queryInvertedIndex(kb.indexes.inverted, query);
  const vecScores = opts.vectorScores ?? new Map<string, number>();
  const directIds = new Set([...invScores.keys(), ...vecScores.keys()]);

  // 查询直接命中的概念：直中证据的概念 ∪ 标签出现在 query 中的概念
  const queryNorm = normalizeLabel(query);
  const matchedConceptIds = new Set<string>();
  for (const evId of directIds) {
    for (const cId of evById.get(evId)?.conceptIds ?? []) matchedConceptIds.add(cId);
  }
  for (const c of kb.concepts) {
    const labels = [c.label, ...c.aliases].map(normalizeLabel).filter((l) => l.length >= 2);
    if (labels.some((l) => queryNorm.includes(l))) matchedConceptIds.add(c.id);
  }

  // ② GraphExpand：命中概念一阶邻域的概念，其证据以 via:'graph' 带出
  const graphConceptIds = new Set<string>();
  if (expand) {
    for (const cId of matchedConceptIds) {
      for (const nb of neighborsOf(kb.indexes.adjacency, cId)) {
        if (!matchedConceptIds.has(nb.to)) graphConceptIds.add(nb.to);
      }
    }
  }

  // ③ FuseRank：确定性加权融合
  const scoreOf = (evId: string): { total: number; parts: EvidencePackItem['scoreParts']; via: 'direct' | 'graph' } => {
    const inv = invScores.get(evId) ?? 0;
    const vec = (vecScores.get(evId) ?? 0) * FUSE_WEIGHTS.vector;
    const ev = evById.get(evId)!;
    const via: 'direct' | 'graph' = directIds.has(evId) ? 'direct' : 'graph';
    const graph = via === 'graph' ? FUSE_WEIGHTS.graphBase * FUSE_WEIGHTS.graphDistanceDecay : 0;
    const conf = Math.max(0, ...ev.conceptIds.map((c) => conceptById.get(c)?.confidence ?? 0)) * FUSE_WEIGHTS.confidence;
    return { total: inv + vec + graph + conf, parts: { inverted: inv, vector: vec, graph, confidence: conf }, via };
  };

  const candidateIds = new Set<string>(directIds);
  for (const cId of graphConceptIds) {
    for (const evId of kb.links.conceptToEvidence[cId] ?? []) candidateIds.add(evId);
  }

  const ranked = [...candidateIds]
    .filter((id) => evById.has(id))
    .map((id) => ({ id, ...scoreOf(id) }))
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));

  // ④ Budget：topK 截取 + token 预算裁剪（确定性顺序累计）
  const items: EvidencePackItem[] = [];
  let totalTokens = 0;
  let truncatedByBudget = 0;
  for (const r of ranked) {
    if (items.length >= topK) break;
    const ev = evById.get(r.id)!;
    if (totalTokens + ev.tokenCount > budget) {
      truncatedByBudget += 1;
      continue;
    }
    totalTokens += ev.tokenCount;
    items.push({
      evidenceId: ev.id,
      text: ev.text,
      score: r.total,
      scoreParts: r.parts,
      via: r.via,
      conceptIds: ev.conceptIds,
      origin: ev.origin,
      citation: ev.citation,
      materialId: ev.materialId,
      sectionOrder: ev.sectionOrder,
      paragraphIndexes: ev.paragraphIndexes,
    });
  }

  // 命中概念与概念间关系（邻接表反推，去重确定性排序）
  const includedConceptIds = new Set<string>([...matchedConceptIds, ...graphConceptIds]);
  const relSeen = new Set<string>();
  const relations: EvidencePack['relations'] = [];
  for (const cId of [...includedConceptIds].sort()) {
    for (const nb of neighborsOf(kb.indexes.adjacency, cId)) {
      if (!includedConceptIds.has(nb.to) || nb.direction !== 'out') continue;
      const key = `${cId}|${nb.to}|${nb.type}`;
      if (relSeen.has(key)) continue;
      relSeen.add(key);
      relations.push({ from: cId, to: nb.to, type: nb.type });
    }
  }

  // ⑤ GapReport：命中概念中证据稀薄者（含图谱扩展带出），以及零命中诚实出口
  const evidenceCountOf = (cId: string) => (kb.links.conceptToEvidence[cId] ?? []).length;
  const thinConcepts = [...includedConceptIds]
    .map((cId) => ({ conceptId: cId, label: conceptById.get(cId)?.label ?? cId, evidenceCount: evidenceCountOf(cId) }))
    .filter((c) => c.evidenceCount === 0 || (items.length < topK && c.evidenceCount < 2))
    .sort((a, b) => a.evidenceCount - b.evidenceCount || a.conceptId.localeCompare(b.conceptId));

  const pack: EvidencePack = {
    query,
    items,
    concepts: [...includedConceptIds].sort().map((cId) => {
      const c = conceptById.get(cId);
      return { id: cId, label: c?.label ?? cId, origin: c?.origin ?? 'corpus', confidence: c?.confidence ?? 0 };
    }),
    relations,
    stats: {
      invertedHits: invScores.size,
      vectorHits: vecScores.size,
      graphExpanded: graphConceptIds.size,
      truncatedByBudget,
      totalTokens,
    },
  };
  if (thinConcepts.length > 0) pack.coverageGaps = thinConcepts;
  const notes: string[] = [];
  if (items.length === 0) {
    notes.push('库内无命中证据：请核对查询词，或按 coverageGaps 采集清单补充材料（SciVerse/摘要集/公开材料）后再查');
  } else if (invScores.size === 0 && vecScores.size > 0) {
    notes.push('倒排零命中，结果全部来自向量召回');
  }
  if (truncatedByBudget > 0) notes.push(`${truncatedByBudget} 条候选因 token 预算被裁剪`);
  if (notes.length > 0) pack.note = notes.join('；');
  return pack;
}
