/**
 * 教学知识库构建（build_teaching_knowledge_base）——KAG-1 R23。
 *
 * 输入：materials（parse 输出数组，可带 citation meta）+ graph（extract/fuse 输出）
 *      + 可选 assessments/qaPairs（wordfamily 回挂关联）。
 * 输出：KB artifact（schema nangying-starmap/kb@1）+ stats + 降级说明。
 * 纯 TS 零 IO；持久化归适配层执行器（.nangying-starmap/kb/<kbId>/kb.json）。
 *
 * 红线：概念 origin 本层恒为 corpus（external/inferred 经 R25 采集回路进入）；
 * citation 缺失字段如实缺省（未提供不补造）；挂接全部确定性可复算。
 */
import type { SkillResult } from '../types.js';
import type { CourseKnowledgeGraph } from '../graph/extractKnowledgeGraph.js';
import { normalizeLabel } from '../graph/diffKnowledgeGraphs.js';
import type { ParseCourseMaterialOutput } from '../nlp/parseCourseMaterial.js';
import {
  CONCEPT_ORIGINS,
  EVIDENCE_ORIGINS,
  KB_ENTITY_FIELDS,
  KB_SCHEMA_ID,
  KB_SCHEMA_VERSION,
  type EvidenceOrigin,
} from './kbSchema.js';
import { buildAdjacency, buildInvertedIndex } from './kbIndex.js';
import { buildLinks, type KbLinkableItem } from './kbLinks.js';
import type { KbCitation, KbConcept, KbEvidence, TeachingKnowledgeBase } from './kbTypes.js';

export const BUILD_TEACHING_KNOWLEDGE_BASE_ID = 'build_teaching_knowledge_base';

/** 采集清单项（缺口概念 → 检索词种子；LLM 扩词由宿主经 select_research_evidence 机制扩展） */
export interface KbAcquisitionPlanItem {
  conceptId: string;
  label: string;
  searchTerms: string[];
}

/** 复核队列项（inferred 概念 / mustReview 挂接，人工确认前六环节显式标注） */
export interface KbReviewQueueItem {
  kind: 'concept' | 'link';
  id: string;
  label: string;
}

/** build 输出：KB artifact + 采集清单 + 复核队列（后两者为派生视图，落盘仅 KB 本体） */
export interface BuildTeachingKnowledgeBaseOutput extends TeachingKnowledgeBase {
  acquisitionPlan: KbAcquisitionPlanItem[];
  reviewQueue: KbReviewQueueItem[];
}

export interface KbMaterialInput {
  materialId: string;
  parse: ParseCourseMaterialOutput;
  /** 证据来源类型（默认 corpus；摘要集导入为 abstractCollection——R25 通道 b） */
  origin?: EvidenceOrigin;
  /** 引用信息（开放材料必填位；缺失字段=未提供） */
  citation?: KbCitation;
}

export interface KbAssessmentInput {
  id: string;
  question: string;
  options?: string[];
}

export interface KbQaPairInput {
  id: string;
  question: string;
  answer: string;
}

export interface KbExternalConceptInput {
  label: string;
  /** external=人工供给公开材料概念；inferred=LLM 提议（进复核队列） */
  origin: 'external' | 'inferred';
  aliases?: string[];
}

export interface KbLlmLinkProposal {
  itemId: string;
  itemKind: 'assessment' | 'qa';
  conceptId: string;
}

export interface BuildTeachingKnowledgeBaseInput {
  /** 材料数组；merge 模式（带 base）可为空数组 */
  materials: KbMaterialInput[];
  graph: CourseKnowledgeGraph;
  assessments?: KbAssessmentInput[];
  qaPairs?: KbQaPairInput[];
  /** R25 采集回路：基于既有 KB 合并扩展（新证据/概念并入，索引关联全量重建） */
  base?: TeachingKnowledgeBase;
  /** R25：外部/提议概念（inferred 进复核队列，人工确认前六环节显式标注） */
  externalConcepts?: KbExternalConceptInput[];
  /** R25：LLM 提议的条目↔概念挂接（确定性校验后 mustReview=true） */
  llmLinkProposals?: KbLlmLinkProposal[];
  /** R25：人工复核确认——true 全部转 human；数组则仅指定 itemId */
  confirmReview?: boolean | string[];
  options?: {
    kbId?: string;
    /** 固定构建时间戳（测试确定性用；缺省取当前时间） */
    builtAt?: string;
  };
}

/** 确定性 token 估算（CJK 为主的教学语料：约 2 字符 1 token；仅用于预算裁剪） */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 2));
}

function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** schema 驱动校验（§4.7 schema-first：校验规则读 KB_SCHEMA 数据，不硬编码枚举） */
export function validateTeachingKnowledgeBase(kb: TeachingKnowledgeBase): string[] {
  const violations: string[] = [];
  if (kb.schemaId !== KB_SCHEMA_ID) violations.push(`schemaId 应为 ${KB_SCHEMA_ID}，实为 ${kb.schemaId}`);
  if (kb.schemaVersion !== KB_SCHEMA_VERSION) violations.push(`schemaVersion 应为 ${KB_SCHEMA_VERSION}，实为 ${kb.schemaVersion}`);
  const conceptIds = new Set(kb.concepts.map((c) => c.id));
  const evidenceIds = new Set(kb.evidence.map((e) => e.id));
  for (const c of kb.concepts) {
    if (!(CONCEPT_ORIGINS as readonly string[]).includes(c.origin)) {
      violations.push(`概念 ${c.id} origin 非法：${c.origin}`);
    }
  }
  const citationKeys = new Set<string>(KB_ENTITY_FIELDS.citation);
  for (const e of kb.evidence) {
    if (!(EVIDENCE_ORIGINS as readonly string[]).includes(e.origin)) {
      violations.push(`证据 ${e.id} origin 非法：${e.origin}`);
    }
    for (const k of Object.keys(e.citation)) {
      if (!citationKeys.has(k)) violations.push(`证据 ${e.id} citation 含白名单外字段：${k}`);
    }
    for (const cId of e.conceptIds) {
      if (!conceptIds.has(cId)) violations.push(`证据 ${e.id} 引用不存在的概念：${cId}`);
    }
  }
  for (const [cId, evIds] of Object.entries(kb.links.conceptToEvidence)) {
    if (!conceptIds.has(cId)) violations.push(`conceptToEvidence 键为未知概念：${cId}`);
    for (const evId of evIds) {
      if (!evidenceIds.has(evId)) violations.push(`conceptToEvidence[${cId}] 引用不存在的证据：${evId}`);
    }
  }
  for (const l of kb.links.evidenceToEvidence) {
    if (!evidenceIds.has(l.from) || !evidenceIds.has(l.to)) {
      violations.push(`evidenceToEvidence 引用不存在的证据：${l.from}→${l.to}`);
    }
  }
  for (const l of kb.links.itemToConcept) {
    if (!conceptIds.has(l.conceptId)) violations.push(`itemToConcept 引用不存在的概念：${l.conceptId}`);
  }
  return violations;
}

function emptyKb(kbId: string, builtAt: string): BuildTeachingKnowledgeBaseOutput {
  return {
    acquisitionPlan: [],
    reviewQueue: [],
    schemaId: KB_SCHEMA_ID,
    schemaVersion: KB_SCHEMA_VERSION,
    kbId,
    builtAt,
    concepts: [],
    evidence: [],
    links: { conceptToEvidence: {}, evidenceToEvidence: [], itemToConcept: [] },
    indexes: { inverted: { terms: {} }, adjacency: {}, vector: null },
    stats: { materials: 0, concepts: 0, evidence: 0, externalRatio: 0, coverageGaps: [] },
  };
}

export function buildTeachingKnowledgeBase(
  input: BuildTeachingKnowledgeBaseInput,
): SkillResult<BuildTeachingKnowledgeBaseOutput> {
  const kbId = input?.options?.kbId ?? input?.base?.kbId ??
    `kb-${stableHash((input?.materials ?? []).map((m) => m.materialId).join('|'))}`;
  const builtAt = input?.options?.builtAt ?? new Date().toISOString();

  // 输入形态守卫：坏输入返回 degraded 空骨架而非抛异常（同 extract 纪律）；
  // merge 模式（带 base）允许空 materials（仅挂接/复核确认/概念扩展）
  if (
    !input || !Array.isArray(input.materials) || (input.materials.length === 0 && !input.base) ||
    !input.graph || !Array.isArray(input.graph.entities) || !Array.isArray(input.graph.relations)
  ) {
    return {
      skillId: BUILD_TEACHING_KNOWLEDGE_BASE_ID,
      level: 'degraded',
      data: emptyKb(kbId, builtAt),
      degradationNote: '输入非 materials+graph 完整形态，返回空 KB 骨架；请先运行 parse_course_material 与 extract_knowledge_graph/fuse_knowledge_graphs',
    };
  }

  // ① 概念：图谱实体承袭（origin=corpus）∪ base 既有（external/inferred 保留）∪ 采集回路外部概念
  const conceptMap = new Map<string, KbConcept>();
  for (const c of input.base?.concepts ?? []) conceptMap.set(c.id, { ...c });
  for (const n of input.graph.entities) {
    if (n.kind !== 'concept') continue;
    conceptMap.set(n.id, {
      id: n.id,
      label: n.label,
      aliases: conceptMap.get(n.id)?.aliases ?? [],
      confidence: n.confidence ?? 0,
      origin: 'corpus',
      source: { sectionOrder: n.source?.sectionOrder ?? [], paragraphIndexes: n.source?.paragraphIndexes ?? [] },
    });
  }
  const labelsInKb = new Set([...conceptMap.values()].map((c) => normalizeLabel(c.label)));
  const rejectedConcepts: string[] = [];
  for (const ec of input.externalConcepts ?? []) {
    const norm = normalizeLabel(ec.label ?? '');
    if (!norm || (ec.origin !== 'external' && ec.origin !== 'inferred')) {
      rejectedConcepts.push(ec.label ?? '(空)');
      continue;
    }
    if (labelsInKb.has(norm)) continue; // 已有同义概念：不重复建
    const id = `con-ext-${stableHash(norm)}`;
    conceptMap.set(id, {
      id,
      label: ec.label.trim(),
      aliases: (ec.aliases ?? []).filter((a) => typeof a === 'string' && a.trim() !== ''),
      confidence: ec.origin === 'inferred' ? 0.2 : 0.5,
      origin: ec.origin,
      source: { sectionOrder: [], paragraphIndexes: [] },
    });
    labelsInKb.add(norm);
  }
  const concepts: KbConcept[] = [...conceptMap.values()].sort((a, b) => a.id.localeCompare(b.id));

  // ② 证据：base 既有保留 + 新材料段落级证据块（chunking 复用 parse 段落寻址；同 id 新材料覆盖）
  const evidenceMap = new Map<string, KbEvidence>();
  for (const e of input.base?.evidence ?? []) evidenceMap.set(e.id, { ...e, conceptIds: [] });
  for (const m of input.materials) {
    for (const p of m.parse.paragraphs ?? []) {
      evidenceMap.set(`ev-${m.materialId}-p${p.index}`, {
        id: `ev-${m.materialId}-p${p.index}`,
        text: p.text,
        origin: m.origin ?? 'corpus',
        materialId: m.materialId,
        sectionOrder: p.sectionOrder,
        paragraphIndexes: [p.index],
        citation: { ...(m.citation ?? {}) },
        conceptIds: [],
        tokenCount: estimateTokens(p.text),
      });
    }
  }
  const evidence: KbEvidence[] = [...evidenceMap.values()].sort((a, b) => a.id.localeCompare(b.id));

  // ③ 条目（题/问答）→ wordfamily 挂接材料
  const items: KbLinkableItem[] = [
    ...(input.assessments ?? []).map((a) => ({
      itemId: a.id,
      itemKind: 'assessment' as const,
      text: [a.question, ...(a.options ?? [])].join(' '),
    })),
    ...(input.qaPairs ?? []).map((q) => ({
      itemId: q.id,
      itemKind: 'qa' as const,
      text: `${q.question} ${q.answer}`,
    })),
  ];

  // ④ 关联 + 索引（merge：base 既有条目挂接保留 ∪ 本轮 wordfamily ∪ LLM 提议（校验后 mustReview））
  const singleMaterialId = !input.base && input.materials.length === 1 ? input.materials[0].materialId : null;
  const links = buildLinks(concepts, evidence, input.graph, singleMaterialId, items);
  const conceptIds = new Set(concepts.map((c) => c.id));
  const itemIds = new Set([
    ...items.map((i) => i.itemId),
    ...(input.base?.links.itemToConcept ?? []).map((l) => l.itemId),
  ]);
  const linkKey = (l: { itemId: string; conceptId: string }) => `${l.itemId}|${l.conceptId}`;
  const existing = new Map(links.itemToConcept.map((l) => [linkKey(l), l]));
  const rejectedProposals: string[] = [];
  for (const l of input.base?.links.itemToConcept ?? []) {
    // base 挂接保留（human/llm 复核状态承袭）；引用已消失概念/条目的如实丢弃
    if (!conceptIds.has(l.conceptId)) continue;
    if (!existing.has(linkKey(l))) existing.set(linkKey(l), { ...l });
  }
  for (const p of input.llmLinkProposals ?? []) {
    if (!conceptIds.has(p.conceptId) || (itemIds.size > 0 && !itemIds.has(p.itemId))) {
      rejectedProposals.push(`${p.itemId}→${p.conceptId}`);
      continue;
    }
    const key = linkKey(p);
    if (existing.get(key)?.linkProvenance === 'human' || existing.get(key)?.linkProvenance === 'wordfamily') continue;
    existing.set(key, { itemId: p.itemId, itemKind: p.itemKind, conceptId: p.conceptId, linkProvenance: 'llm', mustReview: true });
  }
  // 人工复核确认：mustReview 挂接转 human（true=全部；数组=指定 itemId）
  if (input.confirmReview !== undefined && input.confirmReview !== false) {
    const only = Array.isArray(input.confirmReview) ? new Set(input.confirmReview) : null;
    for (const l of existing.values()) {
      if (!l.mustReview) continue;
      if (only && !only.has(l.itemId)) continue;
      l.linkProvenance = 'human';
      l.mustReview = false;
    }
  }
  links.itemToConcept = [...existing.values()].sort((a, b) => a.itemId.localeCompare(b.itemId) || a.conceptId.localeCompare(b.conceptId));
  const indexes = {
    inverted: buildInvertedIndex(evidence),
    adjacency: buildAdjacency(input.graph.relations),
    // merge：base 向量索引承袭（执行器在 embedder 在场时按缓存增量重建）
    vector: input.base?.indexes.vector ?? null,
  };

  // ⑤ stats + 缺口清单（无证据概念，确定性排序）+ 采集清单 + 复核队列
  const externalCount = evidence.filter((e) => e.origin !== 'corpus').length;
  const coverageGaps = concepts
    .filter((c) => (links.conceptToEvidence[c.id] ?? []).length === 0)
    .map((c) => c.id)
    .sort();
  const kb: TeachingKnowledgeBase = {
    schemaId: KB_SCHEMA_ID,
    schemaVersion: KB_SCHEMA_VERSION,
    kbId,
    builtAt,
    concepts,
    evidence,
    links,
    indexes,
    stats: {
      materials: new Set(evidence.map((e) => e.materialId)).size,
      concepts: concepts.length,
      evidence: evidence.length,
      externalRatio: evidence.length > 0 ? externalCount / evidence.length : 0,
      coverageGaps,
    },
  };

  // ⑥ schema 驱动校验（内部一致性；违规=实现 bug，如实上报不静默）
  const violations = validateTeachingKnowledgeBase(kb);
  const notes: string[] = [];
  if (violations.length > 0) notes.push(`KB 校验违规 ${violations.length} 条：${violations.slice(0, 3).join('；')}`);
  if (items.length > 0) {
    const linked = new Set(links.itemToConcept.filter((l) => itemIds.has(l.itemId)).map((l) => l.itemId)).size;
    notes.push(`条目挂接 ${linked}/${items.length}（wordfamily 确定性命中，未命中如实不挂）`);
  }
  if (rejectedConcepts.length > 0) notes.push(`外部概念拒绝 ${rejectedConcepts.length} 个（标签为空或 origin 非法）：${rejectedConcepts.slice(0, 3).join('、')}`);
  if (rejectedProposals.length > 0) notes.push(`LLM 挂接提议拒绝 ${rejectedProposals.length} 条（概念/条目不存在）：${rejectedProposals.slice(0, 3).join('、')}`);
  if (coverageGaps.length > 0) notes.push(`${coverageGaps.length} 个概念暂无证据（coverageGaps，可经采集回路补充）`);
  const reviewQueue = [
    ...concepts.filter((c) => c.origin === 'inferred').map((c) => ({ kind: 'concept' as const, id: c.id, label: c.label })),
    ...links.itemToConcept.filter((l) => l.mustReview).map((l) => ({ kind: 'link' as const, id: `${l.itemId}|${l.conceptId}`, label: `${l.itemId} → ${l.conceptId}` })),
  ];
  if (reviewQueue.length > 0) notes.push(`复核队列 ${reviewQueue.length} 项待人工确认（confirmReview 确认后转 human）`);

  // 采集清单：缺口概念 → 检索词（标签+别名，词族种子；LLM 扩词由宿主经 select_research_evidence 机制扩展）
  const acquisitionPlan = coverageGaps.map((cId) => {
    const c = concepts.find((x) => x.id === cId)!;
    return { conceptId: cId, label: c.label, searchTerms: [c.label, ...c.aliases] };
  });

  return {
    skillId: BUILD_TEACHING_KNOWLEDGE_BASE_ID,
    level: violations.length > 0 ? 'degraded' : 'full',
    data: { ...kb, acquisitionPlan, reviewQueue },
    degradationNote: notes.join('；'),
  };
}
