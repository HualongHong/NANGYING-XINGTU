/**
 * 知识图谱提取（extract_knowledge_graph）——M1 切片。
 *
 * 上游输入为 parse_course_material 的完整输出（章节 + 段落 + 知识点候选）。
 * 纯 TS 实现，零 Node API；LLM 经 SkillContext 宿主注入，失败回落启发式并标 degraded。
 *
 * 图 schema（星图中枢）：
 *  - 节点：章节节点（kind=section，level=章节层级 1 起）与知识点节点
 *    （kind=concept，level=0 概念层），ID 为稳定确定性哈希；
 *  - 边：contains（章节树父子）、related（知识点段落共现，带阈值）、
 *    prerequisite（章节顺序蕴含 + 知识点首次出现顺序）。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import {
  elasticCandidateLimit,
  type KnowledgePointCandidate,
  type ParseCourseMaterialOutput,
  type ParsedSection,
} from '../nlp/parseCourseMaterial.js';
import {
  clusterMapping,
  semanticClusterLabels,
} from '../nlp/semanticCluster.js';

export const EXTRACT_KNOWLEDGE_GRAPH_ID = 'extract_knowledge_graph';

/** 图谱 schema 版本（R3-2：实体出处/置信度 + 边 provenance 起为 1.2） */
export const GRAPH_SCHEMA_VERSION = '1.2';

/** 输入：parse_course_material 的完整输出 */
export type ExtractKnowledgeGraphInput = ParseCourseMaterialOutput;

export type NodeKind = 'section' | 'concept';
export type EdgeType = 'contains' | 'related' | 'prerequisite'
  // R9：产业图谱关系词表（industry_has_occupation 等）——下游按名识别，未知类型忽略
  | 'industry_has_occupation' | 'occupation_has_task' | 'task_requires_skill'
  | 'skill_uses_tool' | 'trend_drives_skill' | string;

/** 实体出处：从哪些章节/段落抽取（反馈 b P1-3：教师可逐条核验） */
export interface EntitySource {
  /** 章节顺序（parse structuredSections 的 order，-1=未归属） */
  sectionOrder: number[];
  /** 段落索引（parse paragraphs 的 index，即候选 occurrences 语义） */
  paragraphIndexes: number[];
}

export interface KnowledgeGraphNode {
  /** 稳定确定性 ID（基于类型+标签哈希，非随机），下游技能可安全引用 */
  id: string;
  kind: NodeKind;
  label: string;
  /** 章节节点=章节层级（1 起）；知识点节点=0（概念层） */
  level: number;
  /** 文档内顺序（知识点按首次出现段落排序） */
  order: number;
  /** 概念实体：出处（章节+段落索引列表） */
  source?: EntitySource;
  /** 概念实体：置信度 0–1（启发式：出现段落数与词频归一；见 conceptConfidence） */
  confidence?: number;
  /** LaTeX 公式片段（R5-5：候选含 $...$/\frac 等模式时保留，下游可透传引用） */
  formula?: string;
  /** 本体类型（R9 产业图谱：industry/occupation/workTask/skill/tool/trend；概念图谱不带） */
  nodeType?: string;
  /** R12-2：融合来源标记（仅 fuse_knowledge_graphs 输出携带；不与 source 的
   *  章节/段落出处语义冲突）——primarySource=主来源 id，mergedSources=归并的全部来源 id */
  fuseMeta?: { primarySource: string; mergedSources: string[] };
}

export interface KnowledgeGraphEdge {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  /** 共现次数等启发式权重 */
  weight: number;
  /** 边来源：heuristic（启发式）/ llm（LLM 精炼关系）；缺省视为 heuristic */
  provenance?: 'heuristic' | 'llm';
}

export interface HierarchySection {
  id: string;
  title: string;
  level: number;
  order: number;
  children: HierarchySection[];
}

export interface PrerequisiteGraph {
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
  /** 先修拓扑排序结果（Kahn，确定性 tie-break） */
  topoOrder: string[];
}

export interface CourseKnowledgeGraph {
  /** 图谱 schema 版本（extract 恒输出 "1.2"；旧快照缺省视为 "1.0" 兼容） */
  schemaVersion?: string;
  /** 知识实体（知识点节点） */
  entities: KnowledgeGraphNode[];
  /** 全部关系边（contains / related / prerequisite） */
  relations: KnowledgeGraphEdge[];
  /** 章节层级组织（嵌套树） */
  hierarchy: HierarchySection[];
  /** 先修/后继关系子图（供学习路径与课程结构设计使用） */
  prerequisiteGraph: PrerequisiteGraph;
  /** 导出格式产物（R5-3：outputFormat 非 json 时给出） */
  output?: string;
  /** 导出格式标识（与 output 同现） */
  format?: 'mermaid' | 'graphml' | 'csv' | 'jsonld';
  /** 统计（R9 产业图谱给出；fuse/diff 忽略） */
  stats?: { nodes: number; edges: number; byType: Record<string, number> };
}

export interface ExtractKnowledgeGraphOptions {
  /** 知识点共现相关边的最小共现段落数（默认 2） */
  cooccurrenceThreshold?: number;
  /** 建图用的候选上限（默认按 elasticCandidateLimit 弹性取值）；
   *  parse 输出保留完整候选池，跨文档融合（fuse）路径可传 Infinity 使用全量 */
  candidateLimit?: number;
  /** 语义聚类（默认 false）：true 且有 ctx.llm 时，建图候选先经 LLM 语义聚类，
   *  簇内标签归并到 canonical 再走上层归并（比色皿/比色杯/比色池 → 比色） */
  semanticClustering?: boolean;
}

// ---------- 确定性 ID ----------

/** djb2 稳定哈希（纯函数、无随机，保证下游引用稳定） */
function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

const sectionId = (s: ParsedSection): string => `sec-${stableHash(`sec:${s.order}:${s.title}`)}`;
const conceptId = (term: string): string => `con-${stableHash(`con:${term}`)}`;

/** 概念节点确定性 ID（跨技能共享：fuse 融合图沿用同标签同 ID，下游可安全引用） */
export const conceptNodeId = conceptId;
const edgeId = (from: string, to: string, type: EdgeType): string =>
  `edge-${stableHash(`${from}->${to}:${type}`)}`;

// ---------- 知识点归并去重 ----------

/** LaTeX 片段判定（R5-5）：行内/块级 $...$ 或常见命令/上下标 */
export function looksLikeLatex(s: string): boolean {
  return /\$[^$\n]+\$|\$\$[\s\S]+?\$\$|\\frac|\\sqrt|\\sum|\\int|[A-Za-z]\^\{?[A-Za-z0-9]/.test(s);
}
/**
 * 概念置信度启发式（0–1，确定性）：
 * 出现段落越多、词频越高越可信——base 0.3，段落多样性 +0.1/段（封顶 5 段），
 * 词频分 score/(score+20) 折算 +0.4。仅供教师核验排序，不作硬阈值。
 */
export function conceptConfidence(c: KnowledgePointCandidate): number {
  const diversity = Math.min(5, c.occurrences.length) * 0.1;
  const freq = (c.score / (c.score + 20)) * 0.4;
  return Math.round(Math.min(1, 0.3 + diversity + freq) * 100) / 100;
}

/**
 * 标签归并：互为子串且出现位置为子集关系的候选视为同一知识点
 * （如"随机梯度下降"⊂"梯度下降"）；位置不子集（如"监督学习"与
 * "无监督学习"）视为不同概念，保留两条。保留得分更高者（同分保留更长
 * 标签），出现位置取并集。输出顺序确定。
 */
export function mergeConceptCandidates(
  candidates: KnowledgePointCandidate[],
): KnowledgePointCandidate[] {
  const sorted = [...candidates].sort(
    (a, b) => b.score - a.score || b.term.length - a.term.length || a.term.localeCompare(b.term, 'zh'),
  );
  const accepted: KnowledgePointCandidate[] = [];
  for (const c of sorted) {
    const idx = accepted.findIndex((a) => {
      if (!(a.term.includes(c.term) || c.term.includes(a.term))) return false;
      const sub = (x: number[], y: number[]) => x.every((v) => y.includes(v));
      return sub(a.occurrences, c.occurrences) || sub(c.occurrences, a.occurrences);
    });
    if (idx === -1) {
      accepted.push(c);
      continue;
    }
    const a = accepted[idx];
    if (c.term.length > a.term.length && c.score >= a.score) {
      accepted[idx] = {
        ...c,
        occurrences: [...new Set([...a.occurrences, ...c.occurrences])].sort((x, y) => x - y),
      };
    } else {
      accepted[idx] = {
        ...a,
        occurrences: [...new Set([...a.occurrences, ...c.occurrences])].sort((x, y) => x - y),
      };
    }
  }
  return accepted;
}

/**
 * 偏移重叠碎片归并（防线）：滑窗碎片链中错开窗口（如
 * "机溶剂回收至有机" / "溶剂回收至有机废"）互不包含、逃过包含式去重。
 * 判定：长度差 ≤2 且存在近乎完全的偏移重叠（suffix-prefix 重合
 * ≥ min(|A|,|B|) - 2，即二者是同一底层串的错开窗口）→ 归并到词频高者。
 */
export function mergeShiftedFragments(
  candidates: KnowledgePointCandidate[],
): KnowledgePointCandidate[] {
  const list = candidates.map((c) => ({ ...c }));
  const maxOverlap = (a: string, b: string): number => {
    const minLen = Math.min(a.length, b.length);
    for (let k = minLen; k > 0; k--) {
      if (a.endsWith(b.slice(0, k)) || b.endsWith(a.slice(0, k))) return k;
    }
    return 0;
  };
  const isShiftedPair = (a: string, b: string): boolean => {
    if (a === b) return false;
    if (a.includes(b) || b.includes(a)) return false; // 包含关系由 mergeConceptCandidates 处理
    if (Math.abs(a.length - b.length) > 2) return false;
    const minLen = Math.min(a.length, b.length);
    if (minLen < 5) return false; // 短词不参与（重叠判据不可靠）
    // 阈值 minLen-3：覆盖滑窗偏移 ≤3 的碎片对（8 字窗错开 4 → 重叠 5 ≈ minLen-3）
    return maxOverlap(a, b) >= minLen - 3;
  };
  for (let pass = 0; pass < 10; pass++) {
    let mergedAny = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!isShiftedPair(list[i].term, list[j].term)) continue;
        const [keepIdx, dropIdx] =
          list[i].score >= list[j].score ? [i, j] : [j, i];
        const keep = list[keepIdx];
        const drop = list[dropIdx];
        keep.score += drop.score;
        keep.occurrences = [...new Set([...keep.occurrences, ...drop.occurrences])].sort((a, b) => a - b);
        list.splice(dropIdx, 1);
        mergedAny = true;
        break outer;
      }
    }
    if (!mergedAny) break;
  }
  return list;
}

// ---------- 章节树 ----------





// ---------- 章节树 ----------

/** LaTeX 片段判定（R5-5）：行内/块级 $...$ 或常见命令/上下标 */

/**
 * 概念置信度启发式（0–1，确定性）：
 * 出现段落越多、词频越高越可信——base 0.3，段落多样性 +0.1/段（封顶 5 段），
 * 词频分 score/(score+20) 折算 +0.4。仅供教师核验排序，不作硬阈值。
 */

function buildHierarchy(
  sections: ParsedSection[],
  idOf: (s: ParsedSection) => string,
): { hierarchy: HierarchySection[]; containsEdges: Array<{ from: string; to: string }> } {
  const hierarchy: HierarchySection[] = [];
  const containsEdges: Array<{ from: string; to: string }> = [];
  // 栈式按层级归位：level 小的为父
  const stack: Array<{ level: number; node: HierarchySection }> = [];
  for (const sec of sections) {
    const node: HierarchySection = {
      id: idOf(sec),
      title: sec.title,
      level: sec.level,
      order: sec.order,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1].level >= sec.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      hierarchy.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
      containsEdges.push({ from: stack[stack.length - 1].node.id, to: node.id });
    }
    stack.push({ level: sec.level, node });
  }
  return { hierarchy, containsEdges };
}

// ---------- 共现相关 ----------

function cooccurrence(
  a: KnowledgePointCandidate,
  b: KnowledgePointCandidate,
): number {
  const setA = new Set(a.occurrences);
  let shared = 0;
  for (const p of b.occurrences) if (setA.has(p)) shared += 1;
  return shared;
}

// ---------- 先修拓扑排序（Kahn，确定性） ----------

function topoSort(nodes: KnowledgeGraphNode[], edges: KnowledgeGraphEdge[]): string[] {
  const prereq = edges.filter((e) => e.type === 'prerequisite');
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) indeg.set(n.id, 0);
  for (const e of prereq) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  }
  const orderOf = new Map(nodes.map((n) => [n.id, n.order]));
  const ready = nodes
    .filter((n) => (indeg.get(n.id) ?? 0) === 0)
    .map((n) => n.id)
    .sort((x, y) => (orderOf.get(x) ?? 0) - (orderOf.get(y) ?? 0));
  const result: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(id);
    for (const next of (adj.get(id) ?? []).sort(
      (x, y) => (orderOf.get(x) ?? 0) - (orderOf.get(y) ?? 0),
    )) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if ((indeg.get(next) ?? 0) === 0) {
        ready.push(next);
        ready.sort((x, y) => (orderOf.get(x) ?? 0) - (orderOf.get(y) ?? 0));
      }
    }
  }
  // 环或孤立节点兜底：补齐未输出节点
  if (result.length < nodes.length) {
    const rest = nodes
      .filter((n) => !result.includes(n.id))
      .sort((a, b) => a.order - b.order)
      .map((n) => n.id);
    result.push(...rest);
  }
  return result;
}

/** 先修拓扑排序（fuse 融合图重建 prerequisiteGraph 时复用） */
export const topoSortGraph = topoSort;

// ---------- LLM 增强 ----------

interface LlmRelation {
  from: string;
  to: string;
  type: 'prerequisite' | 'related';
}

async function refineRelationsWithLlm(
  conceptTerms: string[],
  heuristicRelations: KnowledgeGraphEdge[],
  ctx: SkillContext,
): Promise<{ relations: KnowledgeGraphEdge[]; note: string }> {
  if (!ctx.llm || conceptTerms.length === 0) {
    return { relations: heuristicRelations, note: '' };
  }
  const prompt = [
    '你是课程知识图谱整理助手。以下是一门课程的知识点列表（JSON）：',
    JSON.stringify(conceptTerms),
    '请判断知识点之间的先修/后继关系与相关关系。',
    '严格以 JSON 数组返回，元素格式 {"from":"知识点A","to":"知识点B","type":"prerequisite"|"related"}，',
    '表示 from 是 to 的先修（prerequisite）或两者相关（related）。只输出 JSON 数组本身。',
  ].join('\n');
  try {
    const raw = (await ctx.llm.complete(prompt, { temperature: 0.2 })).trim();
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
    const valid = new Set(conceptTerms);
    const llmRelations: LlmRelation[] = parsed.filter(
      (r): r is LlmRelation =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as LlmRelation).from === 'string' &&
        typeof (r as LlmRelation).to === 'string' &&
        ((r as LlmRelation).type === 'prerequisite' || (r as LlmRelation).type === 'related') &&
        valid.has((r as LlmRelation).from) &&
        valid.has((r as LlmRelation).to),
    );
    if (llmRelations.length === 0) throw new Error('LLM 未返回有效关系');
    // LLM 关系替换启发式知识点级 related / prerequisite 边（章节级保持不变）
    const kept = heuristicRelations.filter(
      (e) => !(e.type !== 'contains' && e.from.startsWith('con-')),
    );
    const llmEdges: KnowledgeGraphEdge[] = llmRelations.map((r) => {
      const from = conceptId(r.from);
      const to = conceptId(r.to);
      return { id: edgeId(from, to, r.type), from, to, type: r.type, weight: 1, provenance: 'llm' as const };
    });
    return { relations: [...kept, ...llmEdges], note: '' };
  } catch {
    return { relations: heuristicRelations, note: 'LLM 关系精炼失败，已回落启发式关系' };
  }
}

// ---------- 主入口 ----------

export async function extractKnowledgeGraph(
  input: ExtractKnowledgeGraphInput,
  ctx: SkillContext = {},
  opts: ExtractKnowledgeGraphOptions = {},
): Promise<SkillResult<CourseKnowledgeGraph>> {
  const threshold = opts.cooccurrenceThreshold ?? 2;

  // 输入形态守卫：非 parse 完整输出时返回 degraded 骨架而非抛异常
  if (
    !input || !Array.isArray(input.paragraphs) ||
    !Array.isArray(input.structuredSections) || !Array.isArray(input.knowledgePointCandidates)
  ) {
    return {
      skillId: EXTRACT_KNOWLEDGE_GRAPH_ID,
      level: 'degraded',
      data: {
        entities: [],
        relations: [],
        hierarchy: [],
        prerequisiteGraph: { nodes: [], edges: [], topoOrder: [] },
      },
      degradationNote: '输入非法：structuredContent 须为 parse_course_material 的完整输出（含 paragraphs/structuredSections/knowledgePointCandidates 数组）；请先调用 parse_course_material',
    };
  }

  // 极端情况：输入为空，按契约语义仅返回空骨架
  if (input.paragraphs.length === 0 && input.structuredSections.length === 0) {
    return {
      skillId: EXTRACT_KNOWLEDGE_GRAPH_ID,
      level: 'degraded',
      data: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        entities: [],
        relations: [],
        hierarchy: [],
        prerequisiteGraph: { nodes: [], edges: [], topoOrder: [] },
      },
      degradationNote: '输入内容为空，仅返回空图谱骨架',
    };
  }

  const nodes: KnowledgeGraphNode[] = [];
  const edges: KnowledgeGraphEdge[] = [];
  const pushEdge = (
    from: string,
    to: string,
    type: EdgeType,
    weight: number,
    provenance: 'heuristic' | 'llm' = 'heuristic',
  ) => {
    const id = edgeId(from, to, type);
    if (edges.some((e) => e.id === id)) return;
    edges.push({ id, from, to, type, weight, provenance });
  };

  // 1) 章节节点 + 包含关系 + 层级树
  for (const sec of input.structuredSections) {
    nodes.push({
      id: sectionId(sec),
      kind: 'section',
      label: sec.title,
      level: sec.level,
      order: sec.order,
    });
  }
  const { hierarchy, containsEdges } = buildHierarchy(
    input.structuredSections,
    sectionId,
  );
  for (const e of containsEdges) pushEdge(e.from, e.to, 'contains', 1);

  // 2) 知识点节点（归并去重，按首次出现排序）
  const limit = opts.candidateLimit ?? elasticCandidateLimit(input.paragraphs);
  let pool = input.knowledgePointCandidates.slice(0, limit)
    // 防御：调用方自构造候选可能缺 occurrences（契约外形态），归一为空数组而非抛错
    .map((c) => (Array.isArray(c.occurrences) ? c : { ...c, occurrences: [] as number[] }));
  // 语义聚类（可选）：LLM 把候选标签聚成规范概念簇，簇内归并到 canonical
  if (opts.semanticClustering && ctx.llm) {
    const clustered = await semanticClusterLabels(
      pool.map((c) => ({ term: c.term, freq: c.score })),
      ctx,
    );
    if (clustered.data!.clusters.length > 0) {
      const mapping = clusterMapping(clustered.data!.clusters);
      pool = pool.map((c) => {
        const canonical = mapping.get(c.term);
        return canonical && canonical !== c.term ? { ...c, term: canonical } : c;
      });
    }
  }
  const merged = mergeShiftedFragments(mergeConceptCandidates(pool));
  const byFirstOccurrence = [...merged].sort(
    (a, b) =>
      Math.min(...a.occurrences, Number.MAX_SAFE_INTEGER) -
        Math.min(...b.occurrences, Number.MAX_SAFE_INTEGER) ||
      b.score - a.score ||
      a.term.localeCompare(b.term, 'zh'),
  );
  // 段落索引 → 章节归属（实体出处用，反馈 b P1-3）
  const paraSectionOrder = new Map(input.paragraphs.map((p) => [p.index, p.sectionOrder]));
  byFirstOccurrence.forEach((c, i) => {
    nodes.push({
      id: conceptId(c.term),
      kind: 'concept',
      label: c.term,
      level: 0,
      order: i,
      source: {
        paragraphIndexes: [...c.occurrences].sort((x, y) => x - y),
        sectionOrder: [...new Set(c.occurrences.map((p) => paraSectionOrder.get(p) ?? -1))].sort((x, y) => x - y),
      },
      confidence: conceptConfidence(c),
      ...(looksLikeLatex(c.term) ? { formula: c.term } : {}),
    });
  });

  // 3) 章节顺序先修：相邻章节链
  const sortedSections = [...input.structuredSections].sort((a, b) => a.order - b.order);
  for (let i = 0; i + 1 < sortedSections.length; i++) {
    pushEdge(sectionId(sortedSections[i]), sectionId(sortedSections[i + 1]), 'prerequisite', 1);
  }

  // 4) 知识点共现相关（阈值）+ 首次出现顺序先修
  for (let i = 0; i < byFirstOccurrence.length; i++) {
    for (let j = i + 1; j < byFirstOccurrence.length; j++) {
      const a = byFirstOccurrence[i];
      const b = byFirstOccurrence[j];
      const shared = cooccurrence(a, b);
      if (shared >= threshold) {
        pushEdge(conceptId(a.term), conceptId(b.term), 'related', shared);
      }
      if (shared >= 1) {
        pushEdge(conceptId(a.term), conceptId(b.term), 'prerequisite', shared);
      }
    }
  }

  // 5) LLM 增强：知识点级关系精炼（失败回落启发式并标 degraded）
  const refined = await refineRelationsWithLlm(
    byFirstOccurrence.map((c) => c.term),
    edges,
    ctx,
  );
  const finalEdges = refined.relations;

  const graph: CourseKnowledgeGraph = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    entities: nodes.filter((n) => n.kind === 'concept'),
    relations: finalEdges,
    hierarchy,
    prerequisiteGraph: {
      nodes: nodes.map((n) => n.id),
      edges: finalEdges
        .filter((e) => e.type === 'prerequisite')
        .map((e) => ({ from: e.from, to: e.to })),
      topoOrder: topoSort(nodes, finalEdges),
    },
  };

  return {
    skillId: EXTRACT_KNOWLEDGE_GRAPH_ID,
    level: refined.note ? 'degraded' : 'full',
    data: graph,
    degradationNote: refined.note,
  };
}
