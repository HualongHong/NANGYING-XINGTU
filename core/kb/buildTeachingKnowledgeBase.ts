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

export interface BuildTeachingKnowledgeBaseInput {
  materials: KbMaterialInput[];
  graph: CourseKnowledgeGraph;
  assessments?: KbAssessmentInput[];
  qaPairs?: KbQaPairInput[];
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

function emptyKb(kbId: string, builtAt: string): TeachingKnowledgeBase {
  return {
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
): SkillResult<TeachingKnowledgeBase> {
  const kbId = input?.options?.kbId ?? `kb-${stableHash((input?.materials ?? []).map((m) => m.materialId).join('|'))}`;
  const builtAt = input?.options?.builtAt ?? new Date().toISOString();

  // 输入形态守卫：坏输入返回 degraded 空骨架而非抛异常（同 extract 纪律）
  if (
    !input || !Array.isArray(input.materials) || input.materials.length === 0 ||
    !input.graph || !Array.isArray(input.graph.entities) || !Array.isArray(input.graph.relations)
  ) {
    return {
      skillId: BUILD_TEACHING_KNOWLEDGE_BASE_ID,
      level: 'degraded',
      data: emptyKb(kbId, builtAt),
      degradationNote: '输入非 materials+graph 完整形态，返回空 KB 骨架；请先运行 parse_course_material 与 extract_knowledge_graph/fuse_knowledge_graphs',
    };
  }

  // ① 概念：图谱实体承袭（origin 恒 corpus；external/inferred 经 R25 采集回路进入）
  const concepts: KbConcept[] = input.graph.entities
    .filter((n) => n.kind === 'concept')
    .map((n) => ({
      id: n.id,
      label: n.label,
      aliases: [],
      confidence: n.confidence ?? 0,
      origin: 'corpus' as const,
      source: { sectionOrder: n.source?.sectionOrder ?? [], paragraphIndexes: n.source?.paragraphIndexes ?? [] },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // ② 证据：段落级证据块（chunking 复用 parse 段落寻址）
  const evidence: KbEvidence[] = [];
  for (const m of input.materials) {
    for (const p of m.parse.paragraphs ?? []) {
      evidence.push({
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
  evidence.sort((a, b) => a.id.localeCompare(b.id));

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

  // ④ 关联 + 索引
  const singleMaterialId = input.materials.length === 1 ? input.materials[0].materialId : null;
  const links = buildLinks(concepts, evidence, input.graph, singleMaterialId, items);
  const indexes = {
    inverted: buildInvertedIndex(evidence),
    adjacency: buildAdjacency(input.graph.relations),
    vector: null,
  };

  // ⑤ stats + 缺口清单（无证据概念，确定性排序）
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
      materials: input.materials.length,
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
    const linked = new Set(links.itemToConcept.map((l) => l.itemId)).size;
    notes.push(`条目挂接 ${linked}/${items.length}（wordfamily 确定性命中，未命中如实不挂）`);
  }
  if (coverageGaps.length > 0) notes.push(`${coverageGaps.length} 个概念暂无证据（coverageGaps，可经采集回路补充）`);

  return {
    skillId: BUILD_TEACHING_KNOWLEDGE_BASE_ID,
    level: violations.length > 0 ? 'degraded' : 'full',
    data: kb,
    degradationNote: notes.join('；'),
  };
}
