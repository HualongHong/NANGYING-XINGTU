/**
 * 学习路径推荐（recommend_learning_path）——N2 切片。
 *
 * 路径推荐本质是图谱遍历，置于 core/graph/。
 * 启发式默认即契约语义：沿 prerequisiteGraph.topoOrder 做拓扑规划——
 * 已知概念剪枝、目标概念反向先修闭包裁剪、分钟预算截断；
 * 输出确定性（topoOrder 次序即 tie-break）。
 * LLM 注入时为每步生成 reason 说明；失败回落模板理由并标 degraded。
 */
import type { SkillContext } from '../llm.js';
import { lexicalTermScore } from './linkKnowledgeIndustry.js';
import type { SkillResult } from '../types.js';
import type { CourseKnowledgeGraph } from './extractKnowledgeGraph.js';

export const RECOMMEND_LEARNING_PATH_ID = 'recommend_learning_path';

/** 学习者画像（契约中 learnerProfile 的结构化形态） */
export interface LearnerProfile {
  /** 已掌握的知识点节点 ID（这些节点不排入路径） */
  knownConceptIds?: string[];
  /** 目标知识点节点 ID：只保留通往目标的先修闭包 */
  goalConceptIds?: string[];
  /** 可用学习时长（分钟），超预算截断 */
  availableMinutes?: number;
}

export interface RecommendLearningPathInput {
  graph: CourseKnowledgeGraph;
  profile: LearnerProfile;
  /** R9：目标岗位（产业图谱岗位实体 ID 或名称）——有值且提供 industryGraph 时，
   *  以该岗位 required skill 的缺口倒排学习优先级；缺省行为逐字节不变 */
  targetOccupation?: string;
  /** R9：产业图谱（#28 build_industry_graph 输出），targetOccupation 生效的前提 */
  industryGraph?: CourseKnowledgeGraph;
}

export interface PathStep {
  nodeId: string;
  title: string;
  kind: 'concept' | 'section';
  /** 步骤说明（LLM 生成或模板理由） */
  reason?: string;
  /** 估算分钟数（章节 10、概念 5） */
  minutes: number;
}

export interface LearningPathOutput {
  /** 个性化学习路径（有序步骤） */
  personalizedPath: PathStep[];
  /** 推荐学习顺序（节点 ID，含先修校验：序与 topoOrder 一致） */
  learningSequence: string[];
  /** 覆盖说明 */
  coverage: {
    skippedKnown: string[];
    goalsReached: string[];
    truncatedByBudget: boolean;
    /** 被目标闭包裁剪掉的节点数 */
    prunedByGoals: number;
  };
}

const MINUTES_OF = (kind: 'concept' | 'section'): number => (kind === 'section' ? 10 : 5);

/** 目标节点的先修传递闭包（含目标自身）；沿 prerequisite 边反向遍历 */
function prerequisiteClosure(goals: string[], graph: CourseKnowledgeGraph): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of graph.relations) {
    if (e.type !== 'prerequisite') continue;
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
  }
  const closure = new Set<string>(goals);
  const stack = [...goals];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const prev of adj.get(cur) ?? []) {
      if (!closure.has(prev)) {
        closure.add(prev);
        stack.push(prev);
      }
    }
  }
  return closure;
}

function templateReason(
  step: { nodeId: string; kind: 'concept' | 'section' },
  graph: CourseKnowledgeGraph,
  isEntry: boolean,
): string {
  if (isEntry) return '路径起点';
  if (step.kind === 'section') return '课程章节主线';
  const outgoing = graph.relations.some(
    (e) => e.type === 'prerequisite' && e.from === step.nodeId,
  );
  return outgoing ? '拓扑必需：是后续概念的先修' : '拓扑必需：目标前置';
}

export async function recommendLearningPath(
  input: RecommendLearningPathInput,
  ctx: SkillContext = {},
): Promise<SkillResult<LearningPathOutput>> {
  const { graph, profile } = input;
  const topo = graph.prerequisiteGraph.topoOrder;
  const nodeById = new Map<string, { title: string; kind: 'concept' | 'section' }>([
    ...graph.entities.map(
      (e) => [e.id, { title: e.label, kind: 'concept' as const }] as [string, { title: string; kind: 'concept' | 'section' }],
    ),
    ...collectSections(graph).map(
      (s) => [s.id, { title: s.title, kind: 'section' as const }] as [string, { title: string; kind: 'concept' | 'section' }],
    ),
  ]);

  if (topo.length === 0) {
    return {
      skillId: RECOMMEND_LEARNING_PATH_ID,
      level: 'degraded',
      data: {
        personalizedPath: [],
        learningSequence: [],
        coverage: { skippedKnown: [], goalsReached: [], truncatedByBudget: false, prunedByGoals: 0 },
      },
      degradationNote: '图谱为空，仅返回空路径骨架',
    };
  }

  const known = new Set(profile.knownConceptIds ?? []);
  const goals = (profile.goalConceptIds ?? []).filter((g) => topo.includes(g));

  // 1) 目标闭包裁剪
  const closure = goals.length > 0 ? prerequisiteClosure(goals, graph) : null;
  const beforePrune = topo.length;
  let candidates = closure ? topo.filter((id) => closure.has(id)) : [...topo];
  const prunedByGoals = closure ? beforePrune - candidates.length : 0;

  // 2) 已知概念剪枝（章节不剪）
  const skippedKnown: string[] = [];
  candidates = candidates.filter((id) => {
    const node = nodeById.get(id);
    if (node?.kind === 'concept' && known.has(id)) {
      skippedKnown.push(id);
      return false;
    }
    return true;
  });

  // 3) 组装步骤 + 预算截断
  let budget = profile.availableMinutes;
  const steps: PathStep[] = [];
  let truncated = false;
  for (const id of candidates) {
    const node = nodeById.get(id);
    if (!node) continue;
    const minutes = MINUTES_OF(node.kind);
    if (budget !== undefined && budget < minutes) {
      truncated = true;
      break;
    }
    if (budget !== undefined) budget -= minutes;
    steps.push({ nodeId: id, title: node.title, kind: node.kind, minutes });
  }

  // 3.5) R9 目标岗位缺口倒排：岗位 required skill 缺口大 → 其先修概念优先
  let occupationNote = ``;
  if (input.targetOccupation && input.industryGraph) {
    const industry = [
      ...(input.industryGraph.entities ?? []).map((e) => ({ id: e.id, label: e.label, nodeType: e.nodeType })),
    ];
    const occ = industry.find((n) => n.nodeType === 'occupation' &&
      (n.id === input.targetOccupation || n.label === input.targetOccupation));
    if (occ) {
      // 岗位要求的 skill：occupation_has_task → task_requires_skill 与直连
      const taskOfOcc = new Set(input.industryGraph.relations.filter((e) => e.type === 'occupation_has_task' && e.from === occ.id).map((e) => e.to));
      const required = new Set<string>();
      for (const e of input.industryGraph.relations) {
        if (e.type === 'task_requires_skill' && (taskOfOcc.has(e.from) || e.from === occ.id)) {
          required.add(e.to);
        }
      }
      const reqLabel = new Map(industry.filter((n) => required.has(n.id)).map((n) => [n.id, n.label]));
      // 词面匹配：required skill → 课程概念（含缺口）
      const anchorScore = new Map<string, number>(); // courseNodeId -> best score
      for (const [reqId, label] of reqLabel) {
        let best: { id: string; score: number } | null = null;
        for (const [id, node] of nodeById) {
          if (node.kind !== 'concept') continue;
          const sc = lexicalTermScore(label, node.title);
          if (sc >= 0.5 && (!best || sc > best.score)) best = { id, score: sc };
        }
        if (best) anchorScore.set(best.id, Math.max(anchorScore.get(best.id) ?? 0, best.score));
      }
      const anchors = new Set(anchorScore.keys());
      const gapSkills = [...reqLabel.entries()].filter(([reqId, label]) =>
        ![...anchorScore.keys()].some((cid) => lexicalTermScore(label, nodeById.get(cid)?.title ?? '') >= 0.5),
      ).map(([, label]) => label);
      // 先修祖先：沿 prerequisite 边正向可达锚点的节点（边 from=先修 → to=后继）
      const adj = new Map<string, string[]>();
      for (const e of graph.relations) {
        if (e.type !== 'prerequisite') continue;
        adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
      }
      const distToAnchor = new Map<string, number>();
      if (anchors.size > 0) {
        // 反向 BFS：从锚点沿逆边收集祖先
        const radj = new Map<string, string[]>();
        for (const e of graph.relations) {
          if (e.type !== 'prerequisite') continue;
          radj.set(e.to, [...(radj.get(e.to) ?? []), e.from]);
        }
        const q: Array<[string, number]> = [...anchors].map((a) => [a, 0]);
        const seenB = new Set(anchors);
        while (q.length > 0) {
          const [cur, d] = q.shift()!;
          if (d >= 12) continue;
          for (const prev of radj.get(cur) ?? []) {
            if (seenB.has(prev)) continue;
            seenB.add(prev);
            distToAnchor.set(prev, d + 1);
            q.push([prev, d + 1]);
          }
        }
      }
      // 稳定重排：祖先（距离近者优先）→ 锚点 → 其余保持原 topo 相对序
      if (anchors.size > 0) {
        const orderOf = new Map(candidates.map((id, i) => [id, i]));
        const rank = (id: string): [number, number] => {
          if (anchors.has(id)) return [1, 0];
          const d = distToAnchor.get(id);
          if (d !== undefined) return [0, d];
          return [2, orderOf.get(id) ?? 0];
        };
        candidates = [...candidates].sort((a, b) => {
          const [ra, da] = rank(a);
          const [rb, db] = rank(b);
          return ra - rb || da - db || (orderOf.get(a) ?? 0) - (orderOf.get(b) ?? 0);
        });
        occupationNote = '目标岗位「' + occ.label + '」：' + reqLabel.size + ' 项要求技能，课程词面覆盖 ' + anchors.size + ' 项'
          + (gapSkills.length > 0
            ? '，缺口 ' + gapSkills.length + ' 项（' + gapSkills.slice(0, 3).join(String.fromCharCode(12289)) + (gapSkills.length > 3 ? String.fromCharCode(8230) : '') + '）'
            : '')
          + '；已按缺口先修倒排优先级';
        // 同步重排已组装的 steps（steps 按 candidates 顺序生成于前——此处重算）
        const stepMap = new Map(steps.map((st) => [st.nodeId, st]));
        const reordered: PathStep[] = [];
        for (const id of candidates) {
          const st = stepMap.get(id);
          if (st) reordered.push(st);
        }
        if (reordered.length === steps.length) steps.splice(0, steps.length, ...reordered);
      }
    }
  }

  // 4) LLM 增强：为每步生成 reason；失败回落模板理由
  let level: 'full' | 'degraded' = 'full';
  let note = '';
  if (ctx.llm && steps.length > 0) {
    const prompt = [
      '你是学习路径规划助手。以下是一条学习路径的有序步骤（JSON）：',
      JSON.stringify(steps.map((s, i) => ({ order: i + 1, title: s.title, kind: s.kind }))),
      '请为每一步给出一句简短的中文学习理由（为什么这一步在此位置）。',
      '严格以 JSON 字符串数组返回，顺序与输入一致，只输出 JSON 数组本身。',
    ].join('\n');
    try {
      const raw = (await ctx.llm.complete(prompt, { temperature: 0.4 })).trim();
      const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
      const parsed: unknown = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
      const reasons = parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
      if (reasons.length !== steps.length) throw new Error('LLM 返回长度不匹配');
      steps.forEach((s, i) => { s.reason = reasons[i]; });
    } catch {
      level = 'degraded';
      note = 'LLM 理由生成失败，已回落模板理由';
      steps.forEach((s, i) => { s.reason = templateReason(s, graph, i === 0); });
    }
  } else {
    steps.forEach((s, i) => { s.reason = templateReason(s, graph, i === 0); });
  }
  if (occupationNote) {
    note = note ? `\${note}；\${occupationNote}` : occupationNote;
  }

  const learningSequence = steps.map((s) => s.nodeId);
  return {
    skillId: RECOMMEND_LEARNING_PATH_ID,
    level,
    data: {
      personalizedPath: steps,
      learningSequence,
      coverage: {
        skippedKnown: skippedKnown.sort((a, b) => topo.indexOf(a) - topo.indexOf(b)),
        goalsReached: goals.filter((g) => learningSequence.includes(g)),
        truncatedByBudget: truncated,
        prunedByGoals,
      },
    },
    degradationNote: note,
  };
}

/** 收集层级树中的全部章节节点（先序） */
function collectSections(graph: CourseKnowledgeGraph): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  const walk = (sec: { id: string; title: string; children: never[] }) => {
    out.push({ id: sec.id, title: sec.title });
    for (const child of sec.children) walk(child);
  };
  for (const root of graph.hierarchy) walk(root as never);
  return out;
}
