/**
 * KB 关联层：概念↔证据（EntitySource 索引映射 ∪ 标签包含匹配）、
 * 证据↔证据（共享概念，防平方爆炸限额）、条目↔概念（wordfamily 挂接）。
 * 全部确定性；LLM 提议挂接为 R25 采集回路位（linkProvenance:'llm' + mustReview）。
 */
import type { CourseKnowledgeGraph } from '../graph/extractKnowledgeGraph.js';
import { normalizeLabel } from '../graph/diffKnowledgeGraphs.js';
import { KB_LIMITS } from './kbSchema.js';
import type {
  KbConcept,
  KbEvidence,
  KbEvidenceToEvidenceLink,
  KbItemToConceptLink,
  KbLinks,
} from './kbTypes.js';
import type { ItemKind } from './kbSchema.js';

export interface KbLinkableItem {
  itemId: string;
  itemKind: ItemKind;
  /** 参与挂接匹配的文本（题干+选项 / 问题+答案） */
  text: string;
}

/** 概念↔证据挂接：
 *  a) 单材料时 EntitySource.paragraphIndexes 直接映射（精确）；
 *  b) 标签/别名归一化包含匹配（多材料融合图谱的通用机制，同时校验 a）。
 *  两路并集去重，确定性排序。 */
export function linkConceptsToEvidence(
  concepts: KbConcept[],
  evidence: KbEvidence[],
  graph: CourseKnowledgeGraph,
  singleMaterialId: string | null,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const evIds = new Set(evidence.map((e) => e.id));
  const entityByLabel = new Map<string, { paragraphIndexes: number[] }>();
  for (const n of graph.entities) {
    if (n.kind !== 'concept') continue;
    entityByLabel.set(normalizeLabel(n.label), { paragraphIndexes: n.source?.paragraphIndexes ?? [] });
  }
  for (const c of concepts) {
    const hits = new Set<string>();
    // a) 索引直映射（单材料；图谱出处可能越界于本材料段落数，仅收真实存在的证据 id）
    if (singleMaterialId) {
      const entity = entityByLabel.get(normalizeLabel(c.label));
      for (const pIdx of entity?.paragraphIndexes ?? []) {
        const evId = `ev-${singleMaterialId}-p${pIdx}`;
        if (evIds.has(evId)) hits.add(evId);
      }
    }
    // b) 标签/别名包含匹配（归一化后子串；标签长度 ≥2 防单字噪声）
    const labels = [c.label, ...c.aliases].map(normalizeLabel).filter((l) => l.length >= 2);
    for (const ev of evidence) {
      if (hits.has(ev.id)) continue;
      const textNorm = normalizeLabel(ev.text);
      if (labels.some((l) => textNorm.includes(l))) hits.add(ev.id);
    }
    out[c.id] = [...hits].sort();
  }
  return out;
}

/** 证据↔证据共享概念关联：weight=共享概念数；每节点出边限额（权重降序、id 升序截断） */
export function linkEvidenceToEvidence(
  evidence: KbEvidence[],
  conceptToEvidence: Record<string, string[]>,
): KbEvidenceToEvidenceLink[] {
  const pairWeight = new Map<string, number>(); // "a|b"（a<b）
  for (const evIds of Object.values(conceptToEvidence)) {
    for (let i = 0; i < evIds.length; i++) {
      for (let j = i + 1; j < evIds.length; j++) {
        const [a, b] = evIds[i] < evIds[j] ? [evIds[i], evIds[j]] : [evIds[j], evIds[i]];
        const key = `${a}|${b}`;
        pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1);
      }
    }
  }
  const links: KbEvidenceToEvidenceLink[] = [...pairWeight.entries()].map(([key, weight]) => {
    const [from, to] = key.split('|');
    return { from, to, via: 'sharedConcept' as const, weight };
  });
  // 每节点限额：按 (weight desc, from, to) 排序后截断
  const degree = new Map<string, number>();
  const sorted = links.sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const kept: KbEvidenceToEvidenceLink[] = [];
  for (const l of sorted) {
    const df = degree.get(l.from) ?? 0;
    const dt = degree.get(l.to) ?? 0;
    if (df >= KB_LIMITS.maxEvidenceLinksPerNode || dt >= KB_LIMITS.maxEvidenceLinksPerNode) continue;
    degree.set(l.from, df + 1);
    degree.set(l.to, dt + 1);
    kept.push(l);
  }
  return kept.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** 条目↔概念 wordfamily 挂接：归一化标签（≥2 字）为条目文本子串即挂接。
 *  确定性命中，mustReview=false；未命中条目如实不挂（不凑数）。 */
export function linkItemsToConcepts(items: KbLinkableItem[], concepts: KbConcept[]): KbItemToConceptLink[] {
  const out: KbItemToConceptLink[] = [];
  const conceptLabels = concepts.map((c) => ({
    id: c.id,
    labels: [c.label, ...c.aliases].map(normalizeLabel).filter((l) => l.length >= 2),
  }));
  for (const item of items) {
    const textNorm = normalizeLabel(item.text);
    for (const c of conceptLabels) {
      if (c.labels.some((l) => textNorm.includes(l))) {
        out.push({ itemId: item.itemId, itemKind: item.itemKind, conceptId: c.id, linkProvenance: 'wordfamily', mustReview: false });
      }
    }
  }
  return out.sort((a, b) => a.itemId.localeCompare(b.itemId) || a.conceptId.localeCompare(b.conceptId));
}

/** 概念→证据反向回填：evidence.conceptIds（由 conceptToEvidence 反推，保持双向一致） */
export function backfillEvidenceConceptIds(evidence: KbEvidence[], conceptToEvidence: Record<string, string[]>): void {
  const byEv = new Map<string, string[]>();
  for (const [conceptId, evIds] of Object.entries(conceptToEvidence)) {
    for (const evId of evIds) {
      (byEv.get(evId) ?? byEv.set(evId, []).get(evId)!).push(conceptId);
    }
  }
  for (const ev of evidence) {
    ev.conceptIds = (byEv.get(ev.id) ?? []).sort();
  }
}

/** 段落侧章节继承（R26 eval 驱动）：无任何直接概念的 corpus 证据，继承其所属章节出现的概念
 *  ——列表引导句（"关键要素："）等结构性短段由此归入章节主题。
 *  只回填 evidence.conceptIds（段落归属语义），**不写 conceptToEvidence**（概念→证据保持直接
 *  挂接口径，coverageGaps/GAP 检测不受稀释）；external 证据不继承（挂接归 §4.5 采集回路）。 */
export function inheritSectionConcepts(concepts: KbConcept[], evidence: KbEvidence[]): void {
  const bySection = new Map<number, string[]>();
  for (const c of concepts) {
    for (const s of c.source.sectionOrder) {
      if (s < 0) continue;
      (bySection.get(s) ?? bySection.set(s, []).get(s)!).push(c.id);
    }
  }
  for (const ev of evidence) {
    if (ev.origin !== 'corpus' || ev.conceptIds.length > 0 || ev.sectionOrder < 0) continue;
    const inherited = bySection.get(ev.sectionOrder) ?? [];
    if (inherited.length > 0) ev.conceptIds = [...new Set([...ev.conceptIds, ...inherited])].sort();
  }
}

export function buildLinks(
  concepts: KbConcept[],
  evidence: KbEvidence[],
  graph: CourseKnowledgeGraph,
  singleMaterialId: string | null,
  items: KbLinkableItem[],
): KbLinks {
  const conceptToEvidence = linkConceptsToEvidence(concepts, evidence, graph, singleMaterialId);
  backfillEvidenceConceptIds(evidence, conceptToEvidence);
  inheritSectionConcepts(concepts, evidence);
  return {
    conceptToEvidence,
    evidenceToEvidence: linkEvidenceToEvidence(evidence, conceptToEvidence),
    itemToConcept: linkItemsToConcepts(items, concepts),
  };
}
