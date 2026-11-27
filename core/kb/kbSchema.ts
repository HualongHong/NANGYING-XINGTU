/**
 * KB 声明式 schema（SPEC KAG-1 §4.1/§4.7 schema-first 纪律）：
 * 实体类型/谓词/枚举/字段白名单/护栏上限全部以数据声明——校验器、
 * LF 语法字段白名单（R25b）、技能文档字段表均由本文件驱动（单一事实源）。
 * 演进=改数据：新增谓词/枚举值/算子只加条目，不改校验逻辑。
 */

export const KB_SCHEMA_ID = 'nangying-starmap/kb';
export const KB_SCHEMA_VERSION = '1.0';

/** 概念分层（G5 开放知识体系：教材层/外部层/LLM 提议层） */
export const CONCEPT_ORIGINS = ['corpus', 'external', 'inferred'] as const;
export type ConceptOrigin = (typeof CONCEPT_ORIGINS)[number];

/** 证据来源类型（citation 要求随来源而变） */
export const EVIDENCE_ORIGINS = ['corpus', 'abstractCollection', 'sciverse', 'publicMaterial'] as const;
export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number];

/** 关联挂接来源（human=人工复核确认） */
export const LINK_PROVENANCES = ['wordfamily', 'llm', 'human'] as const;
export type LinkProvenance = (typeof LINK_PROVENANCES)[number];

/** 可挂接条目类型 */
export const ITEM_KINDS = ['assessment', 'qa'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** 证据↔证据关联的建立方式 */
export const EVIDENCE_LINK_VIA = ['sharedConcept', 'vector'] as const;
export type EvidenceLinkVia = (typeof EVIDENCE_LINK_VIA)[number];

/** 关联谓词声明（演进锚点：新增谓词只加条目） */
export interface KbPredicateDecl {
  name: string;
  from: 'concept' | 'evidence' | 'item';
  to: 'concept' | 'evidence';
  /** 附加上下文枚举（如 evidenceToEvidence 的 via） */
  via?: readonly string[];
}

export const KB_PREDICATES: readonly KbPredicateDecl[] = [
  { name: 'conceptToEvidence', from: 'concept', to: 'evidence' },
  { name: 'evidenceToEvidence', from: 'evidence', to: 'evidence', via: EVIDENCE_LINK_VIA },
  { name: 'itemToConcept', from: 'item', to: 'concept' },
] as const;

/** 实体字段白名单（LF 语法 FILTER/SORT 可用字段、序列化完整性校验共用） */
export const KB_ENTITY_FIELDS = {
  concept: ['id', 'label', 'aliases', 'confidence', 'origin', 'source'],
  evidence: ['id', 'text', 'origin', 'materialId', 'sectionOrder', 'paragraphIndexes', 'citation', 'conceptIds', 'tokenCount'],
  citation: ['url', 'doi', 'venue', 'year', 'retrievedAt', 'license'],
} as const;

/** 护栏上限（R25b 推理层消费；retrieve 的 expand 深度同受约束） */
export const KB_LIMITS = {
  maxTraverseDepth: 3,
  maxPlanOps: 8,
  maxExecutorSteps: 64,
  defaultBudgetTokens: 2000,
  defaultTopK: 5,
  /** 证据↔证据共享概念关联：每节点最多保留的出边数（防平方爆炸） */
  maxEvidenceLinksPerNode: 8,
} as const;

export const KB_SCHEMA = {
  id: KB_SCHEMA_ID,
  version: KB_SCHEMA_VERSION,
  conceptOrigins: CONCEPT_ORIGINS,
  evidenceOrigins: EVIDENCE_ORIGINS,
  linkProvenances: LINK_PROVENANCES,
  itemKinds: ITEM_KINDS,
  evidenceLinkVia: EVIDENCE_LINK_VIA,
  predicates: KB_PREDICATES,
  entityFields: KB_ENTITY_FIELDS,
  limits: KB_LIMITS,
} as const;

export type KbSchema = typeof KB_SCHEMA;
