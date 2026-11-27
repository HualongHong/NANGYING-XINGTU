/**
 * KB 类型定义（schema nangying-starmap/kb@1，SPEC KAG-1 §4.1）。
 * 全部结构可 JSON 序列化（持久化 .nangying-starmap/kb/<kbId>/kb.json）。
 */
import type {
  ConceptOrigin,
  EvidenceOrigin,
  EvidenceLinkVia,
  ItemKind,
  LinkProvenance,
} from './kbSchema.js';

/** 概念（承袭图谱实体，补 origin 分层） */
export interface KbConcept {
  id: string;
  label: string;
  aliases: string[];
  /** 启发式置信度 0–1（承袭图谱 conceptConfidence） */
  confidence: number;
  origin: ConceptOrigin;
  /** 出处（章节顺序 + 段落索引；external/inferred 可为空数组） */
  source: { sectionOrder: number[]; paragraphIndexes: number[] };
}

/** 引用信息（开放证据必填位；字段缺失=未提供，绝不补造） */
export interface KbCitation {
  url?: string;
  doi?: string;
  venue?: string;
  year?: number;
  retrievedAt?: string;
  license?: string;
}

/** 证据块（段落级；chunking 复用 parse 段落寻址，零成本且精确） */
export interface KbEvidence {
  id: string;
  text: string;
  origin: EvidenceOrigin;
  materialId: string;
  sectionOrder: number;
  paragraphIndexes: number[];
  citation: KbCitation;
  conceptIds: string[];
  tokenCount: number;
}

export interface KbEvidenceToEvidenceLink {
  from: string;
  to: string;
  via: EvidenceLinkVia;
  weight: number;
}

export interface KbItemToConceptLink {
  itemId: string;
  itemKind: ItemKind;
  conceptId: string;
  linkProvenance: LinkProvenance;
  /** true=待人工复核（llm/低置信挂接一律进复核队列） */
  mustReview: boolean;
}

export interface KbLinks {
  /** 概念 → 证据 id 列表 */
  conceptToEvidence: Record<string, string[]>;
  evidenceToEvidence: KbEvidenceToEvidenceLink[];
  itemToConcept: KbItemToConceptLink[];
}

/** 倒排索引（可序列化形态：term → [evidenceId, weight][]） */
export interface KbInvertedIndex {
  terms: Record<string, Array<[string, number]>>;
}

/** 概念邻接表（graphExpand 用；双向，带边类型与方向） */
export interface KbAdjacency {
  [conceptId: string]: Array<{ to: string; type: string; direction: 'out' | 'in' }>;
}

export interface KbIndexes {
  inverted: KbInvertedIndex;
  adjacency: KbAdjacency;
  /** 向量索引（R24；embedder 缺席为 null）。textHashes 供增量重建缓存（同文本同模型复用向量） */
  vector: {
    dim: number;
    count: number;
    model?: string;
    entries: Array<[string, number[]]>;
    textHashes?: Record<string, string>;
  } | null;
}

export interface KbStats {
  materials: number;
  concepts: number;
  evidence: number;
  externalRatio: number;
  /** 缺口清单：无证据或薄证据（<minEvidencePerConcept）概念 id */
  coverageGaps: string[];
}

/** KB artifact（schema nangying-starmap/kb@1） */
export interface TeachingKnowledgeBase {
  schemaId: string;
  schemaVersion: string;
  kbId: string;
  builtAt: string;
  concepts: KbConcept[];
  evidence: KbEvidence[];
  links: KbLinks;
  indexes: KbIndexes;
  stats: KbStats;
}

// ---------- 检索输出（evidencePack） ----------

export interface EvidencePackItem {
  evidenceId: string;
  text: string;
  score: number;
  /** 得分构成（诚实报告：倒排/向量/图谱扩展/置信度各占多少） */
  scoreParts: { inverted: number; vector: number; graph: number; confidence: number };
  /** 命中途径：direct（倒排/向量直中）| graph（图谱扩展带出） */
  via: 'direct' | 'graph';
  conceptIds: string[];
  origin: EvidenceOrigin;
  citation: KbCitation;
  materialId: string;
  sectionOrder: number;
  paragraphIndexes: number[];
}

export interface EvidencePack {
  query: string;
  items: EvidencePackItem[];
  /** 命中概念（含图谱扩展带出） */
  concepts: Array<{ id: string; label: string; origin: ConceptOrigin; confidence: number }>;
  /** 命中概念之间的关系边（承袭图谱） */
  relations: Array<{ from: string; to: string; type: string }>;
  stats: {
    invertedHits: number;
    vectorHits: number;
    graphExpanded: number;
    truncatedByBudget: number;
    totalTokens: number;
  };
  /** 缺口报告：命中稀薄时给出相关缺口概念与采集建议 */
  coverageGaps?: Array<{ conceptId: string; label: string; evidenceCount: number }>;
  /** 各级命中为 0 等情形的诚实说明 */
  note?: string;
}
