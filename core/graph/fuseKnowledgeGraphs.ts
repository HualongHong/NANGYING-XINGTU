/**
 * 知识图谱融合（fuse_knowledge_graphs）——N4 切片。
 *
 * 输入：多份课程图谱（星图中枢 schema）+ 来源权重（默认 1，如"讲义权威 > 课件"）。
 * 实体对齐阶梯（确定性优先，LLM 兜底）：
 *  1. 归一化标签完全相等；2. 互为子串；3. 投票（归一化别名在多来源出现，传递闭包并入）；
 *  4. ctx.llm 对冲突候选做语义对齐，失败降级并把 conflicts 如实返回。
 * 边融合：related 按来源加权求和后过重共现阈值；contains 按来源保留各章节子树；
 * prerequisite 取来源并集。章节树为多根森林（各来源章节并列）。
 * ID 稳定性：融合图沿用 extract 的确定性哈希 ID（同标签同 ID），下游技能可安全引用。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import {
  conceptNodeId,
  topoSortGraph,
  GRAPH_SCHEMA_VERSION,
  type CourseKnowledgeGraph,
  type HierarchySection,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
} from './extractKnowledgeGraph.js';
import { normalizeLabel } from './diffKnowledgeGraphs.js';
import { clusterMapping, semanticClusterLabels } from '../nlp/semanticCluster.js';

export const FUSE_KNOWLEDGE_GRAPHS_ID = 'fuse_knowledge_graphs';

export interface FuseKnowledgeGraphsInput {
  graphs: CourseKnowledgeGraph[];
  sources: Array<{ id: string; weight?: number }>;
  /** 可选：各来源的完整候选池（与 graphs 等长，通常直接传 parse_course_material
   *  输出的 knowledgePointCandidates——parse 保留全量池）。用于跨文档词表预融合：
   *  在多个来源候选池中出现的基础概念即使未进各图 top-N，也会被提升进融合实体表 */
  pools?: Array<Array<{ term: string; score?: number; occurrences?: number[] }>>;
}

export interface AlignedGroup {
  canonicalLabel: string;
  memberLabels: string[];
  /** 来源分布：{ 来源 id: 出现次数 } */
  sourceDistribution: Record<string, number>;
}

export interface ConflictCandidate {
  labels: string[];
  sources: string[];
  reason: string;
}

export interface FusionReport {
  alignedGroups: AlignedGroup[];
  conflicts: ConflictCandidate[];
}

export interface FuseKnowledgeGraphsOutput {
  graph: CourseKnowledgeGraph;
  report: FusionReport;
}

export interface FuseKnowledgeGraphsOptions {
  cooccurrenceThreshold?: number;
  /** 语义聚类（默认 false）：true 且有 ctx.llm 时，实体标签先经 LLM 语义聚类，
   *  簇内归并到 canonical 再走确定性对齐阶梯 */
  semanticClustering?: boolean;
}

// ---------- 并查集 ----------

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root !== x) {
      root = this.find(root);
      this.parent.set(x, root);
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** 归一化标签的"投票"键：进一步去掉前后虚词性字符，供多来源别名对齐 */
function voteKey(label: string): string {
  return normalizeLabel(label).replace(/^(的|与|和|及)+|(的)+$/g, '');
}

export async function fuseKnowledgeGraphs(
  input: FuseKnowledgeGraphsInput,
  ctx: SkillContext = {},
  opts: FuseKnowledgeGraphsOptions = {},
): Promise<SkillResult<FuseKnowledgeGraphsOutput>> {
  const { graphs, sources } = input;
  if (graphs.length === 0 || graphs.length !== sources.length) {
    return {
      skillId: FUSE_KNOWLEDGE_GRAPHS_ID,
      level: 'unavailable',
      degradationNote: 'graphs 与 sources 数量不一致或为空',
    };
  }
  const threshold = opts.cooccurrenceThreshold ?? 2;
  const weightOf = (i: number) => sources[i].weight ?? 1;

  // ---- 实体对齐（确定性阶梯）----
  interface SourceEntity { label: string; id: string; order: number; sourceIdx: number }
  const allEntities: SourceEntity[] = [];
  graphs.forEach((g, sourceIdx) => {
    g.entities.forEach((e, order) => allEntities.push({ label: e.label, id: e.id, order, sourceIdx }));
  });

  // 语义聚类（可选）：LLM 把实体标签聚成规范概念簇，簇内先归并到 canonical
  if (opts.semanticClustering && ctx.llm && allEntities.length > 0) {
    const seen = new Map<string, number>();
    for (const e of allEntities) seen.set(e.label, (seen.get(e.label) ?? 0) + 1);
    const clustered = await semanticClusterLabels(
      [...seen.entries()].map(([term, freq]) => ({ term, freq })),
      ctx,
    );
    if (clustered.data!.clusters.length > 0) {
      const mapping = clusterMapping(clustered.data!.clusters);
      for (const e of allEntities) {
        const canonical = mapping.get(e.label);
        if (canonical && canonical !== e.label) e.label = canonical;
      }
    }
  }

  // 跨文档词表预融合：全量候选池中在 ≥2 个来源出现（归一化标签）的术语提升为实体。
  // 修复"词表稀释"——各单元 top-N 被专名占据，共享基础概念（如"比色法"）被挤出候选。
  const pools = input.pools ?? [];
  if (pools.length > 0 && pools.length !== graphs.length) {
    return {
      skillId: FUSE_KNOWLEDGE_GRAPHS_ID,
      level: 'unavailable',
      degradationNote: 'pools 与 graphs 数量不一致',
    };
  }
  if (pools.length > 0) {
    const normInGraph = new Map<string, Set<number>>(); // 归一化标签 → 已有实体的来源
    for (const e of allEntities) {
      const key = normalizeLabel(e.label);
      if (!normInGraph.has(key)) normInGraph.set(key, new Set());
      normInGraph.get(key)!.add(e.sourceIdx);
    }
    const poolByNorm = new Map<string, Array<{ term: string; score: number; srcs: Set<number> }>>();
    pools.forEach((cands, sourceIdx) => {
      for (const c of cands) {
        const key = normalizeLabel(c.term);
        if (!poolByNorm.has(key)) poolByNorm.set(key, []);
        const bucket = poolByNorm.get(key)!;
        let entry = bucket.find((x) => x.term === c.term);
        if (!entry) { entry = { term: c.term, score: 0, srcs: new Set() }; bucket.push(entry); }
        entry.score += (c as { score?: number }).score ?? 0;
        entry.srcs.add(sourceIdx);
      }
    });
    let promoted = 0;
    for (const bucket of poolByNorm.values()) {
      // 代表性标签：词频最高、并列较短
      const best = [...bucket].sort(
        (a, b) => b.score - a.score || a.term.length - b.term.length,
      )[0];
      if (best.srcs.size < 2) continue;
      for (const src of best.srcs) {
        if (normInGraph.get(normalizeLabel(best.term))?.has(src)) continue;
        allEntities.push({
          label: best.term,
          id: conceptNodeId(best.term),
          order: 10000 + promoted,
          sourceIdx: src,
        });
        promoted += 1;
        if (!normInGraph.has(normalizeLabel(best.term))) normInGraph.set(normalizeLabel(best.term), new Set());
        normInGraph.get(normalizeLabel(best.term))!.add(src);
      }
    }
  }

  const uf = new UnionFind();
  const byNorm = new Map<string, SourceEntity[]>();
  for (const e of allEntities) {
    const key = normalizeLabel(e.label);
    // 阶梯 1：归一化相等
    for (const other of byNorm.get(key) ?? []) uf.union(e.label, other.label);
    byNorm.set(key, [...(byNorm.get(key) ?? []), e]);
    // 阶梯 2：互为子串（与 extract 归并同思路，标签级）
    for (const other of allEntities) {
      if (other.label === e.label) continue;
      const a = normalizeLabel(e.label);
      const b = normalizeLabel(other.label);
      if (a.length >= 2 && b.length >= 2 && a !== b &&
          (a.includes(b) || b.includes(a))) {
        uf.union(e.label, other.label);
      }
    }
  }
  // 阶梯 3：投票——同一 voteKey 在多来源出现则并入同组
  const byVote = new Map<string, Set<string>>();
  for (const e of allEntities) {
    const vk = voteKey(e.label);
    if (!byVote.has(vk)) byVote.set(vk, new Set());
    byVote.get(vk)!.add(e.label);
  }
  const voteGroups = new Map<string, Set<number>>(); // voteKey -> sourceIdx set
  for (const e of allEntities) {
    const vk = voteKey(e.label);
    if (!voteGroups.has(vk)) voteGroups.set(vk, new Set());
    voteGroups.get(vk)!.add(e.sourceIdx);
  }
  for (const [vk, labels] of byVote) {
    if ((voteGroups.get(vk)?.size ?? 0) >= 2 && labels.size > 1) {
      const arr = [...labels];
      for (let i = 1; i < arr.length; i++) uf.union(arr[0], arr[i]);
    }
  }

  // ---- 分组与规范标签 ----
  const groups = new Map<string, SourceEntity[]>(); // root -> members
  for (const e of allEntities) {
    const root = uf.find(e.label);
    groups.set(root, [...(groups.get(root) ?? []), e]);
  }
  const canonicalOf = new Map<string, string>(); // label -> canonical
  const alignedGroups: AlignedGroup[] = [];
  for (const members of groups.values()) {
    // 规范标签：覆盖来源数最多者优先，并列取较短（更可能是通名，如"离心"优于"离心操作"）
    const score = new Map<string, number>();
    const labelSources = new Map<string, Set<number>>();
    for (const m of members) {
      if (!labelSources.has(m.label)) labelSources.set(m.label, new Set());
      labelSources.get(m.label)!.add(m.sourceIdx);
    }
    for (const [label, srcSet] of labelSources) score.set(label, srcSet.size);
    const ranked = [...score.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0], 'zh'),
    );
    const canonical = ranked[0][0];
    const sourceDistribution: Record<string, number> = {};
    for (const m of members) {
      sourceDistribution[sources[m.sourceIdx].id] =
        (sourceDistribution[sources[m.sourceIdx].id] ?? 0) + 1;
      canonicalOf.set(m.label, canonical);
    }
    const memberLabels = [...new Set(members.map((m) => m.label))].sort((a, b) => a.localeCompare(b, 'zh'));
    alignedGroups.push({ canonicalLabel: canonical, memberLabels, sourceDistribution });
  }
  alignedGroups.sort((a, b) => a.canonicalLabel.localeCompare(b.canonicalLabel, 'zh'));

  // ---- 冲突候选（确定性阶梯未归并、但前后缀形态相近的跨来源对，留给 LLM/人工）----
  const conflicts: ConflictCandidate[] = [];
  const labels = [...new Set(allEntities.map((e) => e.label))];
  const crossSourcePairs: Array<readonly [string, string]> = [];
  const commonPrefixLen = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  const commonSuffixLen = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  };
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (uf.find(labels[i]) === uf.find(labels[j])) continue;
      const ni = normalizeLabel(labels[i]);
      const nj = normalizeLabel(labels[j]);
      // 收紧判据：前后缀至少 3 字重合才列入冲突候选（2 字噪声大）
      if (commonPrefixLen(ni, nj) >= 3 || commonSuffixLen(ni, nj) >= 3) {
        crossSourcePairs.push([labels[i], labels[j]] as const);
      }
    }
  }

  const conflictSeen = new Set<string>();
  const pushConflict = (ls: string[], reason: string) => {
    const key = [...ls].sort().join('|');
    if (conflictSeen.has(key)) return;
    conflictSeen.add(key);
    const srcSet = new Set<string>();
    for (const l of ls) {
      for (const e of allEntities) if (e.label === l) srcSet.add(sources[e.sourceIdx].id);
    }
    conflicts.push({ labels: [...ls].sort((a, b) => a.localeCompare(b, 'zh')), sources: [...srcSet].sort(), reason });
  };
  for (const [a, b] of crossSourcePairs) {
    pushConflict([a, b], '前后缀相近但未确定性归并（候选）');
  }

  // ---- LLM 兜底对齐 ----
  let level: 'full' | 'degraded' = 'full';
  let note = '';
  if (ctx.llm && conflicts.length > 0) {
    const prompt = [
      '你是课程图谱融合助手。以下实体对形态相近但未能确定性归并（JSON）：',
      JSON.stringify(conflicts.slice(0, 40).map((c) => c.labels)),
      '请判定哪些对语义相同应归并，严格以 JSON 数组返回应归并的对：',
      '[["标签甲","标签乙"],…]。无则返回 []，只输出 JSON。',
    ].join('\n');
    try {
      const raw = (await ctx.llm.complete(prompt, { temperature: 0.2 })).trim();
      const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
      const parsed: unknown = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
      const mergedPairs: Array<[string, string]> = [];
      for (const item of parsed) {
        if (Array.isArray(item) && item.length === 2 &&
            typeof item[0] === 'string' && typeof item[1] === 'string') {
          mergedPairs.push([item[0], item[1]]);
        }
      }
      // 应用 LLM 归并
      for (const [a, b] of mergedPairs) {
        const known = allEntities.some((e) => e.label === a) && allEntities.some((e) => e.label === b);
        if (!known) continue;
        uf.union(a, b);
        const ca = canonicalOf.get(a)!;
        const cb = canonicalOf.get(b)!;
        const keep = ca.length <= cb.length ? ca : cb;
        for (const [l, c] of canonicalOf) if (c === ca || c === cb) canonicalOf.set(l, keep);
        const idx = conflicts.findIndex((c) => c.labels.includes(a) && c.labels.includes(b));
        if (idx >= 0) conflicts.splice(idx, 1);
      }
    } catch {
      level = 'degraded';
      note = 'LLM 语义对齐失败，conflicts 如实返回';
    }
  }

  // ---- 构建融合图 ----
  const canonicalEntities = new Map<string, { order: number }>();
  for (const [label, canonical] of canonicalOf) {
    if (!canonicalEntities.has(canonical)) {
      canonicalEntities.set(canonical, { order: canonicalEntities.size });
    }
  }
  // R12-2：融合来源标记——主来源（canonical 标签的首次出现来源）+ 全部归并来源（确定性序）
  const fuseMetaOf = new Map<string, { primarySource: string; mergedSources: string[] }>();
  {
    const acc = new Map<string, { sources: Set<string>; primary: string | null }>();
    for (const e of allEntities) {
      const canonical = canonicalOf.get(e.label);
      if (!canonical) continue;
      const cur = acc.get(canonical) ?? { sources: new Set<string>(), primary: null };
      const sid = sources[e.sourceIdx].id;
      cur.sources.add(sid);
      if (e.label === canonical && cur.primary === null) cur.primary = sid;
      acc.set(canonical, cur);
    }
    for (const [canonical, cur] of acc) {
      const merged = [...cur.sources].sort((a, b) => a.localeCompare(b, 'zh'));
      fuseMetaOf.set(canonical, { primarySource: cur.primary ?? merged[0] ?? '', mergedSources: merged });
    }
  }
  const entities: KnowledgeGraphNode[] = [...canonicalEntities.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([label, meta]) => ({
      id: conceptNodeId(label),
      kind: 'concept' as const,
      label,
      level: 0,
      order: meta.order,
      ...(fuseMetaOf.has(label) ? { fuseMeta: fuseMetaOf.get(label)! } : {}),
    }));

  // 边融合：related 加权求和过重共现阈值；prerequisite 并集；contains 按来源保留
  const related = new Map<string, KnowledgeGraphEdge>();
  const prerequisite = new Map<string, KnowledgeGraphEdge>();
  const contains: KnowledgeGraphEdge[] = [];
  const remap = (id: string, labelOf?: (id: string) => string | undefined): string => {
    const label = labelOf?.(id);
    if (!label) return id;
    const canonical = canonicalOf.get(label) ?? label;
    return conceptNodeId(canonical);
  };
  graphs.forEach((g, sourceIdx) => {
    const labelOf = (id: string) => g.entities.find((e) => e.id === id)?.label;
    for (const e of g.relations) {
      const from = remap(e.from, e.from.startsWith('con-') ? labelOf : undefined);
      const to = remap(e.to, e.to.startsWith('con-') ? labelOf : undefined);
      if (e.type === 'related') {
        const key = `${from}|${to}`;
        const prev = related.get(key);
        related.set(key, {
          id: `edge-${from}->${to}:related`,
          from, to, type: 'related',
          weight: (prev?.weight ?? 0) + e.weight * weightOf(sourceIdx),
        });
      } else if (e.type === 'prerequisite') {
        const key = `${from}|${to}`;
        if (!prerequisite.has(key)) {
          prerequisite.set(key, { id: `edge-${from}->${to}:prerequisite`, from, to, type: 'prerequisite', weight: e.weight });
        }
      } else {
        contains.push({ ...e });
      }
    }
  });

  const relations: KnowledgeGraphEdge[] = [
    ...[...related.values()].filter((e) => e.weight >= threshold),
    ...prerequisite.values(),
    ...contains,
  ];

  // 章节树：多根森林（各来源章节并列）
  const hierarchy: HierarchySection[] = graphs.flatMap((g) => g.hierarchy);
  const sectionTitles = new Set<string>();
  const walkTitle = (s: HierarchySection) => {
    sectionTitles.add(normalizeLabel(s.title));
    s.children.forEach(walkTitle);
  };
  hierarchy.forEach(walkTitle);

  const nodes: KnowledgeGraphNode[] = [
    ...entities,
    ...hierarchy.flatMap(function collect(sec): KnowledgeGraphNode[] {
      return [
        { id: sec.id, kind: 'section' as const, label: sec.title, level: sec.level, order: sec.order },
        ...sec.children.flatMap(collect),
      ];
    }),
  ];
  const prereqEdges = relations.filter((e) => e.type === 'prerequisite');
  const graph: CourseKnowledgeGraph = {
    // 融合图沿用输入来源的最高 schemaVersion（无输入时按当前版本）
    schemaVersion: graphs.map((g) => g.schemaVersion ?? '1.0').sort().slice(-1)[0] ?? GRAPH_SCHEMA_VERSION,
    entities,
    relations,
    hierarchy,
    prerequisiteGraph: {
      nodes: nodes.map((n) => n.id),
      edges: prereqEdges.map((e) => ({ from: e.from, to: e.to })),
      topoOrder: topoSortGraph(nodes, relations),
    },
  };

  return {
    skillId: FUSE_KNOWLEDGE_GRAPHS_ID,
    level,
    data: { graph, report: { alignedGroups, conflicts } },
    degradationNote: note,
  };
}
