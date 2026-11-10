/**
 * 从知识图谱自动出题（generate_assessment，技能 #22，R4-2）。
 *
 * 背景（反馈 a 4.2-N1）：项目侧最重的产出是整合实践题（题册 + 答案解析 +
 * 常见错误清单），全部人工打磨；错误归因直接决定教学价值。
 *
 * 输入：课程知识图谱（extract/fuse 输出；实体 source/confidence 取材）+ 可选约束
 * （题数/难度/Bloom 层级/解析/典型错误）。输出题册：题干/题型/难度/Bloom/
 * 答案/解析/典型错误/评分点。
 *
 * 启发式默认（无 LLM）：按概念出处与置信度选题，题型轮换（概念解释/辨析/应用），
 * 难度轮转分布，Bloom 按难度映射；答案引用实体出处（章节+置信度）便于核验。
 * LLM 注入时按概念与出处精炼题干/答案/解析；失败回落模板题并标 degraded。
 * 纯 TS、零 Node API、确定性 ID。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import type { CourseKnowledgeGraph, KnowledgeGraphNode } from '../graph/extractKnowledgeGraph.js';

export const GENERATE_ASSESSMENT_ID = 'generate_assessment';

export type AssessmentDifficulty = 'easy' | 'medium' | 'hard';
export type AssessmentBloom = '记忆' | '理解' | '应用' | '分析';
export type AssessmentType = '概念解释' | '辨析' | '应用';

export interface AssessmentItem {
  id: string;
  /** 题干 */
  stem: string;
  type: AssessmentType;
  difficulty: AssessmentDifficulty;
  bloom: AssessmentBloom;
  /** 取材的概念节点 ID（星图可追溯） */
  conceptIds: string[];
  /** 参考答案要点 */
  answer: string;
  /** 解析（includeExplanations 时给出） */
  explanation?: string;
  /** 典型错误（commonErrors 时给出） */
  commonErrors?: string[];
  /** 评分点 */
  scoringPoints: string[];
}

export interface GenerateAssessmentInput {
  graph: CourseKnowledgeGraph;
  /** 题数（默认 10） */
  count?: number;
  /** 难度：'mixed'（默认，三档轮转）| 'easy' | 'medium' | 'hard' */
  difficulty?: AssessmentDifficulty | 'mixed';
  /** Bloom 层级约束（默认全部允许） */
  bloomLevels?: AssessmentBloom[];
  /** 输出解析 */
  includeExplanations?: boolean;
  /** 输出典型错误清单 */
  commonErrors?: boolean;
}

export interface AssessmentBook {
  assessment: AssessmentItem[];
  stats: {
    count: number;
    byDifficulty: Record<string, number>;
    byBloom: Record<string, number>;
  };
}

// ---------- 确定性 ID ----------

function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

const BLOOM_BY_DIFFICULTY: Record<AssessmentDifficulty, AssessmentBloom[]> = {
  easy: ['记忆', '理解'],
  medium: ['理解', '应用'],
  hard: ['应用', '分析'],
};

const TYPE_CYCLE: AssessmentType[] = ['概念解释', '辨析', '应用'];

const ERROR_BANK: Record<AssessmentType, string[]> = {
  概念解释: ['只复述字面定义，未说明内涵', '举例与概念不匹配', '混淆相近术语'],
  辨析: ['只列相同点未指出关键差异', '差异描述空泛无例证', '张冠李戴到相邻概念'],
  应用: ['情境与概念脱节', '只写结论不写推理过程', '忽略适用条件'],
};

/** 实体出处描述（取材标注，反馈 b P1-3 可核验） */
function provenanceOf(entity: KnowledgeGraphNode): string {
  const src = entity.source;
  if (!src) return '';
  const secs = src.sectionOrder.filter((s) => s >= 0);
  const parts: string[] = [];
  if (secs.length > 0) parts.push(`第${secs.map((s) => s + 1).join('/')}节`);
  parts.push(`出现${src.paragraphIndexes.length}段`);
  if (entity.confidence !== undefined) parts.push(`置信度${entity.confidence}`);
  return parts.join('，');
}

/** 启发式模板题（确定性） */
export function templateAssessmentItem(
  entity: KnowledgeGraphNode,
  relatedLabel: string | null,
  index: number,
  difficulty: AssessmentDifficulty,
  bloom: AssessmentBloom,
  opts: { includeExplanations?: boolean; commonErrors?: boolean },
): AssessmentItem {
  const label = entity.label;
  const type = TYPE_CYCLE[index % TYPE_CYCLE.length];
  const prov = provenanceOf(entity);
  const stem =
    type === '概念解释'
      ? `请解释「${label}」的定义，并说明其在课程中的作用。`
      : type === '辨析'
        ? relatedLabel
          ? `请辨析「${label}」与「${relatedLabel}」的关键区别，并各举一例。`
          : `请说明「${label}」与易混淆概念的区别，并举例。`
        : `结合具体情境，说明如何应用「${label}」解决一个实际问题。`;
  const answer =
    type === '辨析' && relatedLabel
      ? `答题要点：分别给出「${label}」与「${relatedLabel}」的准确定义；逐条对比关键差异（内涵/适用条件/示例）；各举一个课程内实例。`
      : `答题要点：给出「${label}」的准确定义；列出关键特征；结合课程实例说明应用场景。`;
  const scoringPoints =
    type === '辨析' && relatedLabel
      ? ['定义准确', '差异点清晰', '例证恰当']
      : ['定义准确', '特征完整', '举例恰当'];
  return {
    id: `asm-${stableHash(`asm:${index}:${label}:${type}`)}`,
    stem,
    type,
    difficulty,
    bloom,
    conceptIds: [entity.id],
    answer,
    ...(opts.includeExplanations
      ? { explanation: `解析：${answer.slice('答题要点：'.length)}${prov ? `（取材：${prov}）` : ''}` }
      : {}),
    ...(opts.commonErrors ? { commonErrors: ERROR_BANK[type] } : {}),
    scoringPoints,
  };
}

/** 主入口：从图谱生成题册 */
export async function generateAssessment(
  input: GenerateAssessmentInput,
  ctx: SkillContext = {},
): Promise<SkillResult<AssessmentBook>> {
  const graph = input.graph;
  if (!graph || !Array.isArray(graph.entities)) {
    return {
      skillId: GENERATE_ASSESSMENT_ID,
      level: 'unavailable',
      degradationNote: '输入校验失败：graph 须为 extract_knowledge_graph / fuse_knowledge_graphs 的输出（含 entities 数组）',
      errorCode: 'INVALID_INPUT',
      example: '{ "graph": <extract_knowledge_graph 输出>, "count": 5, "difficulty": "mixed" }',
    };
  }
  if (graph.entities.length === 0) {
    return {
      skillId: GENERATE_ASSESSMENT_ID,
      level: 'degraded',
      data: { assessment: [], stats: { count: 0, byDifficulty: {}, byBloom: {} } },
      degradationNote: '知识图谱为空，仅返回空题册',
    };
  }

  const count = Math.max(1, Math.min(50, input.count ?? 10));
  const difficultyOpt = input.difficulty ?? 'mixed';
  const allowBloom = new Set<AssessmentBloom>(
    (input.bloomLevels && input.bloomLevels.length > 0
      ? input.bloomLevels
      : ['记忆', '理解', '应用', '分析']) as AssessmentBloom[],
  );

  // 选题：按置信度/顺序取前 count 个（确定性）
  const pool = [...graph.entities]
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || a.order - b.order)
    .slice(0, count);
  // 相关概念标签（辨析题取材：related 边目标）
  const relatedOf = new Map<string, string>();
  for (const e of graph.relations ?? []) {
    if (e.type !== 'related') continue;
    if (!relatedOf.has(e.from)) {
      relatedOf.set(e.from, graph.entities.find((n) => n.id === e.to)?.label ?? '');
    }
  }
  const difficultyOf = (i: number): AssessmentDifficulty =>
    difficultyOpt === 'mixed'
      ? (['easy', 'medium', 'hard'] as const)[i % 3]
      : difficultyOpt;
  const bloomOf = (i: number, d: AssessmentDifficulty): AssessmentBloom => {
    const candidates = BLOOM_BY_DIFFICULTY[d].filter((b) => allowBloom.has(b));
    const list = candidates.length > 0 ? candidates : [...allowBloom];
    return list[i % list.length] ?? '理解';
  };

  let items = pool.map((entity, i) =>
    templateAssessmentItem(
      entity,
      relatedOf.get(entity.id) || null,
      i,
      difficultyOf(i),
      bloomOf(i, difficultyOf(i)),
      { includeExplanations: input.includeExplanations, commonErrors: input.commonErrors },
    ),
  );

  // LLM 精炼：题干/答案/解析按概念与出处重写；失败回落模板题并标 degraded
  let level: 'full' | 'degraded' = 'full';
  let note = '';
  if (ctx.llm) {
    const prompt = [
      '你是课程命题助手。以下是一门课程的知识点（JSON，含出处与置信度）：',
      JSON.stringify(
        pool.map((e) => ({
          concept: e.label,
          provenance: provenanceOf(e),
          related: relatedOf.get(e.id) || null,
        })),
      ),
      `请为每个知识点命一道题（共 ${items.length} 道），覆盖概念解释/辨析/应用；`,
      '每道含：stem（题干）、type（概念解释|辨析|应用）、difficulty（easy|medium|hard）、bloom（记忆|理解|应用|分析）、answer（参考答案要点）、explanation（解析）、commonErrors（典型错误数组）、scoringPoints（评分点数组）。',
      '严格以 JSON 数组返回，顺序与输入一致，只输出 JSON 数组本身。',
    ].join('\n');
    try {
      const raw = (await ctx.llm.complete(prompt, { temperature: 0.5 })).trim();
      const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
      const parsed: unknown = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
      if (parsed.length !== items.length) throw new Error('LLM 返回长度不匹配');
      const refined = parsed.map((p, i) => {
        const o = p as Record<string, unknown>;
        const stem = typeof o.stem === 'string' && o.stem.trim() ? o.stem : items[i].stem;
        const answer = typeof o.answer === 'string' && o.answer.trim() ? o.answer : items[i].answer;
        const asStrings = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
        return {
          ...items[i],
          stem,
          answer,
          ...(input.includeExplanations
            ? { explanation: typeof o.explanation === 'string' ? o.explanation : (items[i].explanation ?? '') }
            : {}),
          ...(input.commonErrors ? { commonErrors: asStrings(o.commonErrors).length > 0 ? asStrings(o.commonErrors) : items[i].commonErrors } : {}),
          scoringPoints: asStrings(o.scoringPoints).length > 0 ? asStrings(o.scoringPoints) : items[i].scoringPoints,
        };
      });
      items = refined;
    } catch {
      level = 'degraded';
      note = 'LLM 命题精炼失败，已回落模板题';
    }
  }

  const byDifficulty: Record<string, number> = {};
  const byBloom: Record<string, number> = {};
  for (const it of items) {
    byDifficulty[it.difficulty] = (byDifficulty[it.difficulty] ?? 0) + 1;
    byBloom[it.bloom] = (byBloom[it.bloom] ?? 0) + 1;
  }

  return {
    skillId: GENERATE_ASSESSMENT_ID,
    level,
    data: { assessment: items, stats: { count: items.length, byDifficulty, byBloom } },
    degradationNote: note,
  };
}
