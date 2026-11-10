/**
 * 知识图谱比对（diff_knowledge_graphs）——N4 切片。
 *
 * 场景：同课程不同来源（课件图谱 vs 讲义图谱）、版本前后（快照 A vs 快照 B）。
 * 实体 ID 是内容哈希，跨文档同标签实体 ID 天然相同，按 ID 差集为主，
 * 归一化标签索引兜底；边按 (from,to,type) 键差集，weight 变化带 delta。
 * similarity 给实体/边 Jaccard 与章节标题重合率。
 * ctx.llm 注入时产出 renamedCandidates（语义重命名候选对），失败降级为空并标 degraded。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import type { CourseKnowledgeGraph, EdgeType } from './extractKnowledgeGraph.js';

export const DIFF_KNOWLEDGE_GRAPHS_ID = 'diff_knowledge_graphs';

export interface DiffKnowledgeGraphsInput {
  graphA: CourseKnowledgeGraph;
  graphB: CourseKnowledgeGraph;
  labelA?: string;
  labelB?: string;
}

export interface DiffEdge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface DiffEdgeChanged extends DiffEdge {
  weightBefore: number;
  weightAfter: number;
  delta: number;
}

export interface RenamedCandidate {
  /** A 侧标签 */
  a: string;
  /** B 侧标签 */
  b: string;
  reason: string;
}

export interface DiffReport {
  labelA: string;
  labelB: string;
  entitiesAdded: string[];
  entitiesRemoved: string[];
  edgesAdded: DiffEdge[];
  edgesRemoved: DiffEdge[];
  edgesChanged: DiffEdgeChanged[];
  similarity: {
    /** 实体 Jaccard（按标签） */
    entities: number;
    /** 边 Jaccard（按 from|to|type 键） */
    edges: number;
    /** 章节标题重合率（|交集| / |并集|） */
    sectionTitles: number;
  };
  renamedCandidates: RenamedCandidate[];
}

/** 标签归一化：去空白/常见标点、拉丁小写（差集兜底索引用） */
export function normalizeLabel(s: string): string {
  return s.replace(/[\s　，。、；：,.;:·\-—_（）()【】\[\]《》<>「」"'"']/g, '').toLowerCase();
}

function entityLabelMap(graph: CourseKnowledgeGraph): Map<string, string> {
  // normLabel -> label；同归一化标签取首个
  const map = new Map<string, string>();
  for (const e of graph.entities) {
    const key = normalizeLabel(e.label);
    if (!map.has(key)) map.set(key, e.label);
  }
  return map;
}

function sectionTitles(graph: CourseKnowledgeGraph): Set<string> {
  const out = new Set<string>();
  const walk = (sec: { title: string; children: never[] }) => {
    out.add(normalizeLabel(sec.title));
    for (const c of sec.children) walk(c);
  };
  for (const root of graph.hierarchy) walk(root as never);
  return out;
}

function edgeKey(e: { from: string; to: string; type: string }): string {
  return `${e.from}|${e.to}|${e.type}`;
}

const jaccard = <T>(a: Set<T>, b: Set<T>): number => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return a.size + b.size === 0 ? 1 : inter / (a.size + b.size - inter);
};

export async function diffKnowledgeGraphs(
  input: DiffKnowledgeGraphsInput,
  ctx: SkillContext = {},
): Promise<SkillResult<DiffReport>> {
  if (!input || !Array.isArray(input.graphA?.entities) || !Array.isArray(input.graphB?.entities)) {
    return {
      skillId: DIFF_KNOWLEDGE_GRAPHS_ID,
      level: 'unavailable',
      degradationNote: '输入校验失败：graphA/graphB 须为星图中枢 schema 图谱对象（含 entities 数组）',
      errorCode: 'INVALID_INPUT',
    };
  }
  const { graphA, graphB } = input;
  const labelA = input.labelA ?? 'A';
  const labelB = input.labelB ?? 'B';

  // 实体差集（归一化标签索引，ID 天然相同者自动落同桶）
  const mapA = entityLabelMap(graphA);
  const mapB = entityLabelMap(graphB);
  const entitiesAdded: string[] = [];
  const entitiesRemoved: string[] = [];
  for (const [key, label] of mapB) if (!mapA.has(key)) entitiesAdded.push(label);
  for (const [key, label] of mapA) if (!mapB.has(key)) entitiesRemoved.push(label);
  entitiesAdded.sort((a, b) => a.localeCompare(b, 'zh'));
  entitiesRemoved.sort((a, b) => a.localeCompare(b, 'zh'));

  // 边差集与 weight 变化
  const edgesA = new Map(graphA.relations.map((e) => [edgeKey(e), e]));
  const edgesB = new Map(graphB.relations.map((e) => [edgeKey(e), e]));
  const edgesAdded: DiffEdge[] = [];
  const edgesRemoved: DiffEdge[] = [];
  const edgesChanged: DiffEdgeChanged[] = [];
  for (const [key, e] of edgesB) {
    if (!edgesA.has(key)) {
      edgesAdded.push({ from: e.from, to: e.to, type: e.type });
    } else {
      const before = edgesA.get(key)!;
      if (before.weight !== e.weight) {
        edgesChanged.push({
          from: e.from, to: e.to, type: e.type,
          weightBefore: before.weight, weightAfter: e.weight,
          delta: e.weight - before.weight,
        });
      }
    }
  }
  for (const [key, e] of edgesA) {
    if (!edgesB.has(key)) edgesRemoved.push({ from: e.from, to: e.to, type: e.type });
  }
  const sortEdge = (a: DiffEdge, b: DiffEdge) =>
    edgeKey(a).localeCompare(edgeKey(b));
  edgesAdded.sort(sortEdge);
  edgesRemoved.sort(sortEdge);
  edgesChanged.sort(sortEdge);

  // 相似度
  const titlesA = sectionTitles(graphA);
  const titlesB = sectionTitles(graphB);
  const similarity = {
    entities: jaccard(new Set(mapA.keys()), new Set(mapB.keys())),
    edges: jaccard(new Set(edgesA.keys()), new Set(edgesB.keys())),
    sectionTitles: jaccard(titlesA, titlesB),
  };

  // LLM：语义重命名候选对（A 独有 vs B 独有的标签）
  let renamedCandidates: RenamedCandidate[] = [];
  let level: 'full' | 'degraded' = 'full';
  let note = '';
  if (ctx.llm && (entitiesRemoved.length > 0 || entitiesAdded.length > 0)) {
    const prompt = [
      `你是课程图谱比对助手。"${labelA}"侧独有实体：${JSON.stringify(entitiesRemoved.slice(0, 40))}；`,
      `"${labelB}"侧独有实体：${JSON.stringify(entitiesAdded.slice(0, 40))}。`,
      '请找出两侧语义相同但措辞不同的实体（重命名对），严格以 JSON 数组返回：',
      '[{"a":"A侧标签","b":"B侧标签","reason":"一句说明"}]。无候选返回 []，只输出 JSON。',
    ].join('\n');
    try {
      const raw = (await ctx.llm.complete(prompt, { temperature: 0.2 })).trim();
      const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
      const parsed: unknown = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
      renamedCandidates = parsed.filter(
        (x): x is RenamedCandidate =>
          typeof x === 'object' && x !== null &&
          typeof (x as RenamedCandidate).a === 'string' &&
          typeof (x as RenamedCandidate).b === 'string',
      );
    } catch {
      level = 'degraded';
      note = 'LLM 重命名候选生成失败，renamedCandidates 为空';
    }
  }

  return {
    skillId: DIFF_KNOWLEDGE_GRAPHS_ID,
    level,
    data: {
      labelA, labelB,
      entitiesAdded, entitiesRemoved, edgesAdded, edgesRemoved, edgesChanged,
      similarity, renamedCandidates,
    },
    degradationNote: note,
  };
}
