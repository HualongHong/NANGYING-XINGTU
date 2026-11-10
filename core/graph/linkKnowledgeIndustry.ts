/**
 * 知识点-产业需求关联（link_knowledge_industry，技能 #29，R9）。
 *
 * 三层机制：
 *  1. 词面层（永远可用）：术语精确匹配 + glossary + 词面重叠打分（CJK 字 bigram
 *     包含率，确定性），阈值 0.5；
 *  2. LLM 语义层（宿主注入时启用）：知识点→skill/task 逐对打分（0-1 相关度 + 理由
 *     + 证据句），maxLinksPerNode 控制扇出；失败/超时回落词面层并诚实标注 degraded；
 *  3. 聚合层：按岗位/产业链环节聚合课程覆盖度——供需缺口（产业要求但课程未覆盖，
 *     按关联岗位权重和 heat 排序 + "建议补充教学点"）、课程冗余（零产业关联）、matched 清单
 *     （带课程实体 source 出处，呼应 R3 溯源）。
 *
 * 输入兼容：courseGraph 支持 conceptual（entities）与 experimental（nodes）两种实体
 * 字段名；industryGraph 为 #28 输出；jobPostings（原始招聘文本数组）经 LLM/词面
 * 现场抽取补充产业侧实体后再关联。纯 TS、零 Node API、确定性（词面/聚合层）。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import type { CourseKnowledgeGraph } from './extractKnowledgeGraph.js';
import { lexicalIndustryExtract, type IndustryEntityType } from './buildIndustryGraph.js';
import type { Glossary } from '../i18n/glossary.js';

export const LINK_KNOWLEDGE_INDUSTRY_ID = 'link_knowledge_industry';

export type LinkType = 'maps_to_skill' | 'supports_task' | 'needed_by_occupation';
export type LinkSource = 'lexical' | 'llm';

export interface IndustryLink {
  from: string;
  to: string;
  type: LinkType;
  /** 0-1 相关度 */
  confidence: number;
  evidence: string;
  source: LinkSource;
}

export interface KnowledgeIndustryGap {
  industryEntityId: string;
  label: string;
  type: string;
  /** 要求该能力的岗位数（heat，排序键） */
  demandedByOccupations: string[];
  heat: number;
  suggestion: string;
}

export interface KnowledgeIndustryReport {
  links: IndustryLink[];
  matched: IndustryLink[];
  gaps: KnowledgeIndustryGap[];
  coverage: Array<{ entityId: string; label: string; source?: unknown; note: string }>;
  stats: { lexical: number; llm: number; gaps: number; coverage: number };
}

export interface LinkKnowledgeIndustryInput {
  courseGraph: CourseKnowledgeGraph;
  industryGraph: CourseKnowledgeGraph;
  /** 原始招聘文本数组：现场抽取补充产业侧实体后再关联 */
  jobPostings?: string[];
  maxLinksPerNode?: number;
  glossary?: Glossary;
}

// ---------- 实体归一（conceptual entities / experimental nodes / 产业 nodeType） ----------

interface NormEntity {
  id: string;
  label: string;
  nodeType?: string;
  source?: unknown;
}

function normalizeEntities(graph: unknown): NormEntity[] {
  if (!graph || typeof graph !== 'object') return [];
  const g = graph as { entities?: unknown[]; nodes?: unknown[] };
  const raw = Array.isArray(g.entities) ? g.entities : Array.isArray(g.nodes) ? g.nodes : [];
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e, i) => ({
      id: typeof e.id === 'string' ? e.id : `n-${i}`,
      label: typeof e.label === 'string' ? e.label : String(e.id ?? i),
      ...(typeof e.nodeType === 'string' ? { nodeType: e.nodeType } : {}),
      ...(e.source !== undefined ? { source: e.source } : {}),
    }));
}

// ---------- 词面层 ----------

/** CJK 字 bigram 集合（拉丁词按整词） */
function tokenBigrams(s: string): Set<string> {
  const out = new Set<string>();
  const cleaned = s.toLowerCase().replace(/[\s\-_/·・,，。、:：()（）\[\]]+/g, '');
  for (let i = 0; i + 2 <= cleaned.length; i++) out.add(cleaned.slice(i, i + 2));
  return out;
}

/** 词面相似度（确定性）：精确 1 / 相互包含 0.8 / bigram 包含率 */
export function lexicalTermScore(a: string, b: string): number {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;
  const A = tokenBigrams(na);
  const B = tokenBigrams(nb);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}

const LINK_TYPE_OF: Record<string, LinkType> = {
  skill: 'maps_to_skill',
  tool: 'maps_to_skill',
  workTask: 'supports_task',
  occupation: 'needed_by_occupation',
};

function linkTypeOf(nodeType: string | undefined): LinkType | null {
  return nodeType ? (LINK_TYPE_OF[nodeType] ?? null) : null;
}

// ---------- 聚合层 ----------

/** 岗位需求关系索引：occupation → 其要求的 skill/task 权重和（经 occupation_has_task → task_requires_skill 与直连；R10-2 起边权重=共现句数，sections 形态恒 1） */
function occupationDemand(industry: NormEntity[], relations: Array<{ from: string; to: string; type: string; weight?: number }>): Map<string, Map<string, number>> {
  const taskOfOcc = new Map<string, Map<string, number>>();
  const skillOfTask = new Map<string, Map<string, number>>();
  const skillOfOcc = new Map<string, Map<string, number>>();
  const add = (m: Map<string, Map<string, number>>, from: string, to: string, w: number) => {
    const cur = m.get(from) ?? new Map<string, number>();
    cur.set(to, (cur.get(to) ?? 0) + w);
    m.set(from, cur);
  };
  for (const e of relations) {
    const w = typeof e.weight === 'number' && e.weight > 0 ? e.weight : 1;
    if (e.type === 'occupation_has_task') {
      add(taskOfOcc, e.from, e.to, w);
    } else if (e.type === 'task_requires_skill') {
      add(skillOfTask, e.from, e.to, w);
      // 直连形态：occupation → skill 也用 task_requires_skill（buildIndustryGraph 的直连分支）
      add(skillOfOcc, e.from, e.to, w);
    }
  }
  const demand = new Map<string, Map<string, number>>(); // occupationId -> skill/task id → 权重（同岗位多路径取 max，避免任务重复计权）
  for (const occ of industry.filter((n) => n.nodeType === 'occupation')) {
    const wanted = new Map<string, number>();
    const bump = (id: string, w: number) => wanted.set(id, Math.max(wanted.get(id) ?? 0, w));
    for (const [task, w1] of taskOfOcc.get(occ.id) ?? []) {
      bump(task, w1);
      for (const [sk, w2] of skillOfTask.get(task) ?? []) bump(sk, w2);
    }
    for (const [sk, w] of skillOfOcc.get(occ.id) ?? []) bump(sk, w);
    demand.set(occ.id, wanted);
  }
  return demand;
}

// ---------- 主入口 ----------

export async function linkKnowledgeIndustry(
  input: LinkKnowledgeIndustryInput,
  ctx: SkillContext = {},
): Promise<SkillResult<KnowledgeIndustryReport>> {
  if (!input?.courseGraph || !input?.industryGraph) {
    return {
      skillId: LINK_KNOWLEDGE_INDUSTRY_ID,
      level: 'unavailable',
      errorCode: 'INVALID_INPUT',
      degradationNote: '输入校验失败：courseGraph 与 industryGraph 为必需（#28 build_industry_graph 的输出可直接作 industryGraph）',
      example: '{ "courseGraph": <extract 输出>, "industryGraph": <build_industry_graph 输出> }',
    };
  }

  const course = normalizeEntities(input.courseGraph);
  const industry = normalizeEntities(input.industryGraph);
  const relations = (input.industryGraph.relations ?? []) as Array<{ from: string; to: string; type: string; weight?: number }>;
  const maxLinks = Math.max(1, Math.min(10, input.maxLinksPerNode ?? 5));
  const glossaryTerms = new Set(
    (input.glossary?.entries ?? []).map((e) => e.term.trim()).filter(Boolean),
  );

  // jobPostings：现场抽取补充产业侧实体（LLM 优先，词面回落）
  let postingsNote = '';
  if (Array.isArray(input.jobPostings) && input.jobPostings.length > 0) {
    const extra: NormEntity[] = [];
    for (const posting of input.jobPostings) {
      if (typeof posting !== 'string' || !posting.trim()) continue;
      let extracted: Array<{ type: IndustryEntityType; label: string }> | null = null;
      if (ctx.llm) {
        try {
          const prompt = [
            '你是产教对接助手。以下是岗位招聘文本：',
            posting.slice(0, 3000),
            '请抽取产业侧实体，严格以 JSON 数组返回：[{"type":"occupation|workTask|skill|tool|trend","label":"实体名"}]，只输出 JSON 数组本身。',
          ].join('\n');
          const raw = (await ctx.llm.complete(prompt, { temperature: 0.2 })).trim();
          const parsed: unknown = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
          if (Array.isArray(parsed) && parsed.length > 0) {
            extracted = parsed
              .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
              .map((x) => ({ type: String(x.type) as IndustryEntityType, label: String(x.label ?? '') }))
              .filter((x) => ['occupation', 'workTask', 'skill', 'tool', 'trend'].includes(x.type) &&
                x.label.trim().length >= 2 && x.label.trim().length <= 30);
          }
        } catch { extracted = null; }
      }
      if (!extracted) {
        extracted = lexicalIndustryExtract(posting);
        postingsNote = '部分招聘文本经词面启发式抽取（LLM 缺失或失败）';
      }
      let hash = 0;
      for (let i = 0; i < posting.length && i < 64; i++) hash = ((hash << 5) + hash + posting.charCodeAt(i)) | 0;
      const tag = `jd-${(hash >>> 0).toString(36)}`;
      const typeSeq: Record<string, number> = {};
      // 去重：与既有产业节点（含本帖前文抽取）同 type+label 时不重复建节点，
      // 避免同一技能在 text 形态与 JD 补充中各建一份导致 gaps/matched 重复
      const existingKeys = new Set([...industry, ...extra].map((n) => `${n.nodeType}:${n.label.trim()}`));
      for (const e of extracted) {
        const key = `${e.type}:${e.label.trim()}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        typeSeq[e.type] = (typeSeq[e.type] ?? 0) + 1;
        extra.push({
          id: `ind-${tag}-${e.type}-${typeSeq[e.type]}`,
          label: e.label.trim(),
          nodeType: e.type,
          source: { posting: posting.slice(0, 80) },
        });
      }
    }
    industry.push(...extra);
  }

  // 1) 词面层（永远可用）
  const links: IndustryLink[] = [];
  const linkKeys = new Set<string>();
  const pushLink = (l: IndustryLink) => {
    const key = `${l.from}|${l.to}|${l.type}`;
    if (linkKeys.has(key)) return;
    linkKeys.add(key);
    links.push(l);
  };
  for (const c of course) {
    for (const ind of industry) {
      const type = linkTypeOf(ind.nodeType);
      if (!type) continue;
      let score = lexicalTermScore(c.label, ind.label);
      if (score < 0.5 && glossaryTerms.has(c.label) && glossaryTerms.has(ind.label)) {
        score = Math.max(score, lexicalTermScore(c.label, ind.label));
      }
      if (score < 0.5) continue;
      pushLink({
        from: c.id,
        to: ind.id,
        type,
        confidence: Math.round(score * 100) / 100,
        evidence: score === 1 ? '术语精确匹配' : score === 0.8 ? '词面包含匹配' : `词面重叠 ${score.toFixed(2)}`,
        source: 'lexical',
      });
    }
  }
  const lexicalCount = links.length;

  // 2) LLM 语义层
  let level: 'full' | 'degraded' = 'full';
  let note = postingsNote;
  if (ctx.llm && course.length > 0 && industry.length > 0) {
    try {
      const prompt = [
        '你是产教对接评估助手。左侧是课程知识点（JSON，含出处），右侧是产业侧实体（JSON，含类型）：',
        JSON.stringify({
          course: course.map((c) => ({ id: c.id, label: c.label, source: c.source })),
          industry: industry.map((n) => ({ id: n.id, label: n.label, type: n.nodeType })),
        }),
        '请判断课程知识点与产业 skill/workTask 的相关性（occupation 仅在知识点直接对应岗位能力时关联）。',
        '严格以 JSON 数组返回：[{"from":"课程实体id","to":"产业实体id","score":0.0-1.0,"reason":"理由","evidence":"课程侧证据句或实体出处"}]',
        `只输出 JSON 数组本身。相关度 < 0.4 的不输出。每课程实体最多 ${maxLinks} 条。`,
      ].join('\n');
      const raw = (await ctx.llm.complete(prompt, { temperature: 0.2 })).trim();
      const parsed: unknown = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
      const courseIds = new Set(course.map((c) => c.id));
      const industryIds = new Set(industry.map((n) => n.id));
      const perNode = new Map<string, number>();
      const candidates: IndustryLink[] = [];
      for (const item of parsed.slice(0, 200) as Array<Record<string, unknown>>) {
        const from = String(item.from ?? '');
        const to = String(item.to ?? '');
        const score = Number(item.score);
        if (!courseIds.has(from) || !industryIds.has(to)) continue;
        if (!Number.isFinite(score) || score < 0.4) continue;
        const type = linkTypeOf(industry.find((n) => n.id === to)?.nodeType) ?? 'maps_to_skill';
        candidates.push({
          from, to, type,
          confidence: Math.round(score * 100) / 100,
          evidence: typeof item.evidence === 'string' ? item.evidence : (typeof item.reason === 'string' ? item.reason : 'LLM 语义关联'),
          source: 'llm',
        });
      }
      candidates.sort((a, b) => b.confidence - a.confidence);
      for (const c of candidates) {
        const used = perNode.get(c.from) ?? 0;
        if (used >= maxLinks) continue;
        perNode.set(c.from, used + 1);
        pushLink(c);
      }
    } catch {
      level = 'degraded';
      note = note ? `${note}；` : '';
      note += 'LLM 语义关联失败，已回落词面层（确定性重叠打分）';
    }
  } else if (!ctx.llm) {
    note = note ? `${note}；` : '';
    note += '未注入 LLM：仅词面层关联（精确/包含/bigram 重叠）';
  }

  // 3) 聚合层
  const linkedIndustry = new Set(links.map((l) => l.to));
  const linkedCourse = new Set(links.map((l) => l.from));
  const demand = occupationDemand(industry, relations);
  const occLabel = new Map(industry.filter((n) => n.nodeType === 'occupation').map((n) => [n.id, n.label]));

  const gaps: KnowledgeIndustryGap[] = [];
  for (const ind of industry) {
    if (ind.nodeType !== 'skill' && ind.nodeType !== 'workTask') continue;
    if (linkedIndustry.has(ind.id)) continue;
    const demanding = [...demand.entries()].filter(([, wanted]) => wanted.has(ind.id));
    gaps.push({
      industryEntityId: ind.id,
      label: ind.label,
      type: ind.nodeType!,
      demandedByOccupations: demanding.map(([occId]) => occLabel.get(occId) ?? occId),
      heat: demanding.reduce((acc, [, wanted]) => acc + (wanted.get(ind.id) ?? 0), 0),
      suggestion: ind.nodeType === 'skill'
        ? `建议补充教学点：${ind.label}`
        : `建议补充实训任务：${ind.label}`,
    });
  }
  gaps.sort((a, b) => b.heat - a.heat || a.label.localeCompare(b.label, 'zh'));

  const coverage = course
    .filter((c) => !linkedCourse.has(c.id))
    .map((c) => ({
      entityId: c.id,
      label: c.label,
      ...(c.source !== undefined ? { source: c.source } : {}),
      note: '零产业关联：考虑是否为纯学术内容，或在产业侧补充对应需求描述',
    }));

  return {
    skillId: LINK_KNOWLEDGE_INDUSTRY_ID,
    level,
    data: {
      links,
      matched: links,
      gaps,
      coverage,
      stats: { lexical: lexicalCount, llm: links.length - lexicalCount, gaps: gaps.length, coverage: coverage.length },
    },
    degradationNote: note,
  };
}
