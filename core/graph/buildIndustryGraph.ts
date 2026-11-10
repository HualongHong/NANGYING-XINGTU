/**
 * 产业图谱构建（build_industry_graph，技能 #28，R9）。
 *
 * 产教图谱第三张图谱（与 conceptual/experimental 同级，graphType:"industry"）：
 *  - 实体类型：industry（产业/产业链环节）/ occupation（岗位）/ workTask（工作任务）
 *    / skill（技能要求）/ tool（工具/技术）/ trend（趋势/政策驱动）；
 *  - 关系：industry_has_occupation / occupation_has_task / task_requires_skill /
 *    skill_uses_tool / trend_drives_skill；
 *  - 输出沿用 extract 骨架（entities/relations/hierarchy/prerequisiteGraph/
 *    stats.byType/schemaVersion），确定性 ID（djb2 同哈希族），fuse/diff/render_preview 直接兼容。
 *
 * 输入双形态：
 *  1. sections+fields：[{ id?, title, fields }]——键名（产业链环节/岗位/工作任务/
 *     技能要求/工具/趋势，含常见别名）经 fieldMap 归一到六类本体；
 *  2. 自由文本（岗位 JD/教学标准/招聘启事）text：复用 parse_course_material 的
 *     段落候选——LLM 注入时抽取为产业实体；无 LLM 回落词面启发式（岗位词典后缀 +
 *     动词短语模式：熟悉/掌握/要求/具备 → skill；负责/承担/开展/参与 → workTask），
 *     R10-2 起词面路径按句子级共现建边（岗位-技能/任务须同句或相邻句 window 可配
 *     共现，边权重=共现句数），level=degraded 诚实标注。
 *
 * 数据不做内置库；契约示例给形态。纯 TS、零 Node API、确定性。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import type { CourseKnowledgeGraph, KnowledgeGraphEdge, KnowledgeGraphNode } from './extractKnowledgeGraph.js';
import { parseCourseMaterial } from '../nlp/parseCourseMaterial.js';

export const BUILD_INDUSTRY_GRAPH_ID = 'build_industry_graph';

export type IndustryEntityType = 'industry' | 'occupation' | 'workTask' | 'skill' | 'tool' | 'trend';
export type IndustryRelationType =
  | 'industry_has_occupation'
  | 'occupation_has_task'
  | 'task_requires_skill'
  | 'skill_uses_tool'
  | 'trend_drives_skill';

export interface IndustrySection {
  id?: string;
  title: string;
  fields: Record<string, unknown>;
}

export interface BuildIndustryGraphInput {
  /** sections+fields 形态（与 text 二选一） */
  sections?: IndustrySection[];
  /** 字段键名映射：{ 用户键: industry|occupation|workTask|skill|tool|trend } */
  fieldMap?: Record<string, string>;
  /** 自由文本形态：岗位 JD / 教学标准 / 招聘启事 */
  text?: string;
  /** R10-2：词面层共现窗口（相邻句数，0=仅同句；text 形态词面路径生效） */
  lexicalWindow?: number;
}

// ---------- 确定性 ID ----------

function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

const industryId = (type: string, label: string): string =>
  `ind-${stableHash(`${type}:${label}`)}`;

/** 字段键别名 → 六类本体 */
const FIELD_KEY_ALIASES: Record<string, IndustryEntityType> = {
  产业链环节: 'industry', 产业链: 'industry', 环节: 'industry', 产业: 'industry',
  岗位: 'occupation', 职位: 'occupation', 职业: 'occupation', 岗位群: 'occupation',
  工作任务: 'workTask', 任务: 'workTask', 职责: 'workTask', 工作内容: 'workTask',
  技能要求: 'skill', 技能: 'skill', 能力要求: 'skill', 任职要求: 'skill', 要求: 'skill',
  工具: 'tool', 技术: 'tool', 工具技术: 'tool', 仪器设备: 'tool',
  趋势: 'trend', 政策: 'trend', 发展趋势: 'trend', 驱动: 'trend',
};

const STANDARD_FIELD_KEYS = new Set(['industry', 'occupation', 'workTask', 'skill', 'tool', 'trend']);

function canonicalFieldKey(rawKey: string, fieldMap?: Record<string, string>): IndustryEntityType | null {
  const key = rawKey.trim();
  if (!key) return null;
  if (fieldMap) {
    const mapped = fieldMap[key] ?? fieldMap[key.toLowerCase()];
    if (mapped && STANDARD_FIELD_KEYS.has(mapped)) return mapped as IndustryEntityType;
  }
  const direct = FIELD_KEY_ALIASES[key];
  if (direct) return direct;
  const lowered = key.toLowerCase();
  if (STANDARD_FIELD_KEYS.has(lowered)) return lowered as IndustryEntityType;
  return null;
}

/** 字段值归一为条目列表（数组原样；字符串按 、，,；; 切分） */
function fieldValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[、，,；;]/).map((v) => v.trim()).filter(Boolean);
  if (value === undefined || value === null) return [];
  return [String(value).trim()].filter(Boolean);
}

// ---------- 图谱组装（sections+fields 与自由文本共用） ----------

interface GraphBuilder {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  pushNode: (type: IndustryEntityType, label: string, week?: string) => string;
  pushEdge: (from: string, to: string, type: IndustryRelationType, weight?: number) => void;
}

function createBuilder(): GraphBuilder {
  const nodes: KnowledgeGraphNode[] = [];
  const edges: KnowledgeGraphEdge[] = [];
  const ids = new Set<string>();
  const pushNode = (type: IndustryEntityType, label: string, tag?: string): string => {
    const id = industryId(type, tag ? `${tag}:${label}` : label);
    if (!ids.has(id)) {
      ids.add(id);
      nodes.push({ id, kind: 'concept', label, level: 0, order: nodes.length, nodeType: type });
    }
    return id;
  };
  const pushEdge = (from: string, to: string, type: IndustryRelationType, weight = 1): void => {
    if (edges.some((e) => e.from === from && e.to === to && e.type === type)) return;
    if (from === to) return;
    edges.push({
      id: `edge-${stableHash(`${from}->${to}:${type}`)}`,
      from, to, type, weight, provenance: 'heuristic',
    });
  };
  return { nodes, edges, pushNode, pushEdge };
}

function finalize(builder: GraphBuilder): CourseKnowledgeGraph {
  const byType: Record<string, number> = {};
  for (const n of builder.nodes) byType[n.nodeType ?? 'unknown'] = (byType[n.nodeType ?? 'unknown'] ?? 0) + 1;
  return {
    schemaVersion: '1.2',
    entities: builder.nodes,
    relations: builder.edges,
    hierarchy: [],
    prerequisiteGraph: { nodes: builder.nodes.map((n) => n.id), edges: [], topoOrder: [] },
    stats: { nodes: builder.nodes.length, edges: builder.edges.length, byType },
  };
}

/** sections+fields 形态：每 section = 一个产业节点，字段按链接线 */
function buildFromSections(builder: GraphBuilder, sections: IndustrySection[], fieldMap?: Record<string, string>): void {
  sections.forEach((sec, secIdx) => {
    const tag = sec.id ?? `S${secIdx + 1}`;
    const industryIdLocal = builder.pushNode('industry', sec.title, tag);
    const perType = new Map<IndustryEntityType, string[]>();
    for (const [rawKey, rawValue] of Object.entries(sec.fields)) {
      const key = canonicalFieldKey(rawKey, fieldMap);
      if (!key) continue;
      const values = fieldValues(rawValue)
        .map((v) => v.replace(/^(熟悉|掌握|精通|了解|具备|要求熟悉|要求掌握|要求具备|负责|承担|参与|开展)\s*/, '').trim())
        .filter(Boolean);
      if (values.length === 0) continue;
      perType.set(key, [...(perType.get(key) ?? []), ...values]);
    }
    const typedIds = (type: IndustryEntityType): string[] =>
      (perType.get(type) ?? []).map((v) => builder.pushNode(type, v, tag));
    const occupations = typedIds('occupation');
    const tasks = typedIds('workTask');
    const skills = typedIds('skill');
    const tools = typedIds('tool');
    const trends = typedIds('trend');
    // 产业链接线：industry → occupation → task → skill → tool；trend → skill
    for (const occ of occupations) {
      builder.pushEdge(industryIdLocal, occ, 'industry_has_occupation');
      for (const t of tasks) builder.pushEdge(occ, t, 'occupation_has_task');
    }
    // 无岗位时 task 直接挂产业（教学标准形态常见）
    for (const t of tasks) {
      if (occupations.length === 0) builder.pushEdge(industryIdLocal, t, 'occupation_has_task');
      for (const sk of skills) builder.pushEdge(t, sk, 'task_requires_skill');
    }
    if (tasks.length === 0) {
      // 无任务层时 skill 直接挂岗位/产业
      for (const sk of skills) {
        for (const occ of occupations) builder.pushEdge(occ, sk, 'task_requires_skill');
        if (occupations.length === 0) builder.pushEdge(industryIdLocal, sk, 'task_requires_skill');
      }
    }
    for (const sk of skills) {
      for (const tool of tools) builder.pushEdge(sk, tool, 'skill_uses_tool');
    }
    for (const tr of trends) {
      for (const sk of skills) builder.pushEdge(tr, sk, 'trend_drives_skill');
      if (skills.length === 0) {
        for (const occ of occupations) builder.pushEdge(tr, occ, 'trend_drives_skill');
      }
    }
  });
}

// ---------- 自由文本形态 ----------

const OCCUPATION_SUFFIX = /(工程师|专员|主管|经理|研究员|技术员|助理|分析师|培训师|实验员|质检员|注册师)$/;
const SKILL_LEADERS = /^(熟悉|掌握|精通|了解|具备|要求熟悉|要求掌握|要求具备)/;
const TASK_LEADERS = /^(负责|承担|开展|参与|完成|协助)/;

/** 单句词面抽取（岗位后缀 + 动词短语模式；去重归 lexicalIndustryExtract 外层） */
function extractSentenceEntities(sentence: string): Array<{ type: IndustryEntityType; label: string }> {
  const out: Array<{ type: IndustryEntityType; label: string }> = [];
  const push = (type: IndustryEntityType, label: string) => {
    const t = label.trim();
    if (!t || t.length < 2 || t.length > 30) return;
    out.push({ type, label: t });
  };
  // 岗位：句中"XX 工程师/专员…"后缀词典
  for (const m of sentence.matchAll(/[一-鿿A-Za-z（）()]{2,20}?(?:工程师|专员|主管|经理|研究员|技术员|助理|分析师|实验员|质检员)/g)) {
    push('occupation', m[0].replace(/^(招聘|诚聘|急聘|岗位[:：]?|职位[:：]?)/, ''));
  }
  if (OCCUPATION_SUFFIX.test(sentence) && sentence.length <= 30) {
    push('occupation', sentence.replace(/^(招聘|诚聘|急聘|岗位[:：]?|职位[:：]?)/, ''));
  }
  // 技能/任务：动词短语模式（捕获允许空格：JD 常见"熟悉 GLP 规范"）
  for (const m of sentence.matchAll(/(?:熟悉|掌握|精通|了解|具备)+([一-鿿A-Za-z0-9、/\s]{2,24})/g)) {
    for (const part of m[1].split(/[、/]/)) push('skill', part);
  }
  for (const m of sentence.matchAll(/(?:负责|承担|开展|参与)+([一-鿿A-Za-z0-9、/\s]{2,24})/g)) {
    for (const part of m[1].split(/[、/]/)) push('workTask', part);
  }
  return out;
}

/** 词面启发式：岗位词典 + 动词短语模式（确定性；无 LLM 时回落，level=degraded） */
export function lexicalIndustryExtract(text: string): Array<{ type: IndustryEntityType; label: string }> {
  const out: Array<{ type: IndustryEntityType; label: string }> = [];
  const seen = new Set<string>();
  const sentences = text.split(/(?<=[。；;\n!！?？])/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    for (const e of extractSentenceEntities(sentence)) {
      const key = `${e.type}:${e.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

export interface LexicalCooccurEdge {
  from: { type: IndustryEntityType; label: string };
  to: { type: IndustryEntityType; label: string };
  relation: IndustryRelationType;
  /** 共现句数（每个满足窗口的句位计一次） */
  weight: number;
}

/**
 * R10-2：词面层句子级共现——岗位与其技能/任务须同句（或相邻句，window 可配，
 * 0=仅同句，最大 3）共现才建边，边权重=共现句数。确定性。
 */
export function lexicalIndustryCooccur(text: string, window = 0): LexicalCooccurEdge[] {
  const w = Math.max(0, Math.min(3, Math.floor(Number.isFinite(window) ? window : 0)));
  const sentences = text
    .split(/(?<=[。；;\n!！?？])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const per = sentences.map((s) => {
    const occ = new Map<string, string>();
    const skill = new Map<string, string>();
    const task = new Map<string, string>();
    for (const e of extractSentenceEntities(s)) {
      const bucket = e.type === 'occupation' ? occ : e.type === 'skill' ? skill : e.type === 'workTask' ? task : null;
      if (bucket && !bucket.has(e.label)) bucket.set(e.label, e.label);
    }
    return { occ, skill, task };
  });
  const acc = new Map<string, LexicalCooccurEdge>();
  for (let i = 0; i < per.length; i++) {
    const occs = new Map<string, string>();
    const skills = new Map<string, string>();
    const tasks = new Map<string, string>();
    for (let j = i; j <= Math.min(i + w, per.length - 1); j++) {
      for (const [k, v] of per[j].occ) occs.set(k, v);
      for (const [k, v] of per[j].skill) skills.set(k, v);
      for (const [k, v] of per[j].task) tasks.set(k, v);
    }
    for (const oLabel of occs.keys()) {
      for (const sLabel of skills.keys()) {
        const key = `${oLabel}->${sLabel}:task_requires_skill`;
        const cur = acc.get(key);
        if (cur) cur.weight += 1;
        else acc.set(key, { from: { type: 'occupation', label: oLabel }, to: { type: 'skill', label: sLabel }, relation: 'task_requires_skill', weight: 1 });
      }
      for (const tLabel of tasks.keys()) {
        const key = `${oLabel}->${tLabel}:occupation_has_task`;
        const cur = acc.get(key);
        if (cur) cur.weight += 1;
        else acc.set(key, { from: { type: 'occupation', label: oLabel }, to: { type: 'workTask', label: tLabel }, relation: 'occupation_has_task', weight: 1 });
      }
    }
  }
  return [...acc.values()];
}

/** LLM 抽取：JD → 产业实体列表（失败抛错由调用方回落） */
async function llmIndustryExtract(
  text: string,
  ctx: SkillContext,
): Promise<Array<{ type: IndustryEntityType; label: string }>> {
  const prompt = [
    '你是产教对接助手。以下是一段岗位描述/招聘文本：',
    text.slice(0, 4000),
    '请抽取产业侧实体，严格以 JSON 数组返回：[{"type":"industry|occupation|workTask|skill|tool|trend","label":"实体名"}]。',
    '只输出 JSON 数组本身。',
  ].join('\n');
  const raw = (await ctx.llm!.complete(prompt, { temperature: 0.2 })).trim();
  const parsed: unknown = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
  const valid: Array<{ type: IndustryEntityType; label: string }> = [];
  for (const item of parsed.slice(0, 100) as Array<Record<string, unknown>>) {
    const t = item?.type;
    const l = item?.label;
    if (typeof t !== 'string' || typeof l !== 'string') continue;
    if (!STANDARD_FIELD_KEYS.has(t)) continue;
    const label = l.trim();
    if (label.length >= 2 && label.length <= 30) valid.push({ type: t as IndustryEntityType, label });
  }
  if (valid.length === 0) throw new Error('LLM 未返回有效实体');
  return valid;
}

/** 自由文本形态接线：根产业节点（来源句）→ occupation → skill/task（LLM 类型驱动） */
function buildFromEntities(
  builder: GraphBuilder,
  sourceTag: string,
  entities: Array<{ type: IndustryEntityType; label: string }>,
): void {
  const ids = new Map<IndustryEntityType, string[]>();
  for (const e of entities) {
    const id = builder.pushNode(e.type, e.label, sourceTag);
    ids.set(e.type, [...(ids.get(e.type) ?? []), id]);
  }
  const first = (t: IndustryEntityType): string | undefined => ids.get(t)?.[0];
  const root = first('industry') ?? (() => {
    const rid = builder.pushNode('industry', sourceTag, sourceTag);
    return rid;
  })();
  const occupations = ids.get('occupation') ?? [];
  const skills = ids.get('skill') ?? [];
  const tasks = ids.get('workTask') ?? [];
  const tools = ids.get('tool') ?? [];
  const trends = ids.get('trend') ?? [];
  for (const occ of occupations) {
    builder.pushEdge(root, occ, 'industry_has_occupation');
    for (const t of tasks) builder.pushEdge(occ, t, 'occupation_has_task');
    for (const sk of skills) builder.pushEdge(occ, sk, 'task_requires_skill');
  }
  if (occupations.length === 0) {
    for (const t of tasks) builder.pushEdge(root, t, 'occupation_has_task');
    for (const sk of skills) builder.pushEdge(root, sk, 'task_requires_skill');
  }
  for (const sk of skills) {
    for (const tool of tools) builder.pushEdge(sk, tool, 'skill_uses_tool');
  }
  for (const tr of trends) {
    for (const sk of skills) builder.pushEdge(tr, sk, 'trend_drives_skill');
  }
}

// ---------- 主入口 ----------

export async function buildIndustryGraph(
  input: BuildIndustryGraphInput,
  ctx: SkillContext = {},
): Promise<SkillResult<CourseKnowledgeGraph>> {
  const builder = createBuilder();
  const hasSections = Array.isArray(input?.sections) && input.sections.length > 0;
  const hasText = typeof input?.text === 'string' && input.text.trim().length > 0;
  if (!hasSections && !hasText) {
    return {
      skillId: BUILD_INDUSTRY_GRAPH_ID,
      level: 'unavailable',
      errorCode: 'INVALID_INPUT',
      degradationNote: '输入校验失败：sections（[{ id?, title, fields }]）与 text（岗位 JD/招聘文本）二选一',
      example: '{ "sections": [{ "title": "生物医药检测", "fields": { "岗位": ["体外诊断试剂研发工程师"], "技能要求": ["酶动力学参数测定"] } }] }',
    };
  }

  if (hasSections) {
    const bad = input.sections!.some((s) => !s || typeof s.title !== 'string' || !s.fields || typeof s.fields !== 'object');
    if (bad) {
      return {
        skillId: BUILD_INDUSTRY_GRAPH_ID,
        level: 'unavailable',
        errorCode: 'INVALID_INPUT',
        degradationNote: '输入校验失败：sections 每项须为 { id?, title, fields: { 键: 值或数组 } }',
        example: '{ "sections": [{ "title": "生物医药检测", "fields": { "岗位": "质检工程师", "技能要求": ["分光光度法"] } }] }',
      };
    }
    buildFromSections(builder, input.sections!, input.fieldMap);
    return {
      skillId: BUILD_INDUSTRY_GRAPH_ID,
      level: 'full',
      data: finalize(builder),
      degradationNote: '',
    };
  }

  // 自由文本形态：LLM 抽取优先，回落词面启发式（degraded 诚实标注）
  if (ctx.llm) {
    try {
      const entities = await llmIndustryExtract(input.text!, ctx);
      buildFromEntities(builder, `text-${stableHash(input.text!.slice(0, 64))}`, entities);
      return {
        skillId: BUILD_INDUSTRY_GRAPH_ID,
        level: 'full',
        data: finalize(builder),
        degradationNote: '',
      };
    } catch {
      // 回落词面启发式
    }
  }
  // 词面启发式（复用 parse 的段落候选分词质量：JD 本身即文本）
  const parsed = await parseCourseMaterial({ content: input.text!, materialType: 'txt' }, {});
  void parsed;
  const entities = lexicalIndustryExtract(input.text!);
  if (entities.length === 0) {
    return {
      skillId: BUILD_INDUSTRY_GRAPH_ID,
      level: 'unavailable',
      errorCode: 'INVALID_INPUT',
      degradationNote: '未能从文本抽取任何产业实体（无 LLM 词面启发式未命中：岗位词典/动词短语模式）；请改用 sections+fields 形态或注入 LLM',
      example: '{ "text": "体外诊断试剂研发工程师：要求熟悉酶动力学参数测定、分光光度法……" }',
    };
  }
  // R10-2：词面路径改句子级共现建边（岗位-技能/任务须同句或相邻句共现，权重=共现句数）；
  // 共现为空才回退旧的平铺全连接
  const sourceTag = `text-${stableHash(input.text!.slice(0, 64))}`;
  const cooccur = lexicalIndustryCooccur(input.text!, input.lexicalWindow ?? 0);
  if (cooccur.length > 0) {
    const root = builder.pushNode('industry', sourceTag, sourceTag);
    // 全部词面实体建节点（孤儿技能/任务挂根产业，保持标签齐全与图连通）
    const idOf = new Map<string, string>();
    for (const e of lexicalIndustryExtract(input.text!)) {
      idOf.set(`${e.type}:${e.label}`, builder.pushNode(e.type, e.label, sourceTag));
    }
    const occIds: string[] = [];
    const connected = new Set<string>();
    for (const ce of cooccur) {
      const fromId = idOf.get(`${ce.from.type}:${ce.from.label}`)!;
      const toId = idOf.get(`${ce.to.type}:${ce.to.label}`)!;
      if (ce.from.type === 'occupation' && !occIds.includes(fromId)) occIds.push(fromId);
      builder.pushEdge(fromId, toId, ce.relation, ce.weight);
      connected.add(toId);
    }
    for (const [key, id] of idOf) {
      const type = key.slice(0, key.indexOf(':'));
      if ((type === 'skill' || type === 'workTask') && !connected.has(id)) {
        builder.pushEdge(root, id, type === 'skill' ? 'task_requires_skill' : 'occupation_has_task', 1);
      }
    }
    for (const occId of occIds) builder.pushEdge(root, occId, 'industry_has_occupation', 1);
    return {
      skillId: BUILD_INDUSTRY_GRAPH_ID,
      level: 'degraded',
      data: finalize(builder),
      degradationNote: ctx.llm
        ? 'LLM 产业实体抽取失败，已回落词面启发式（句子级共现窗口建边，权重=共现句数）'
        : '未注入 LLM：词面启发式抽取（句子级共现窗口建边），实体粒度有限；注入 llm 后可得完整产业实体',
    };
  }
  buildFromEntities(builder, sourceTag, lexicalIndustryExtract(input.text!));
  return {
    skillId: BUILD_INDUSTRY_GRAPH_ID,
    level: 'degraded',
    data: finalize(builder),
    degradationNote: ctx.llm
      ? 'LLM 产业实体抽取失败，已回落词面启发式（岗位词典+动词短语模式），实体粒度有限'
      : '未注入 LLM：词面启发式抽取（岗位词典+动词短语模式），实体粒度有限；注入 llm 后可得完整产业实体',
  };
}
