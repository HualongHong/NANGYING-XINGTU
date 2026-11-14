/**
 * 教学需求治理（gather_teaching_requirements）核心：纯函数，零 IO。
 * 开工必问清单 Q1–Q8 的校验与停工判定、约束分层（通用 H / 项目 P）与
 * 约束登记表（方法论 1.3/1.4「纠偏即登记」）、迭代场景「沿用并复述」回放。
 * 交互提问由宿主 agent 执行（技能文档给出问题与时机），本模块只做判定与结构。
 */

/** 必问清单项（方法论 0.3 / 附录 A；blocking=缺则停工不编造，defaultable=有默认但须复述，collect=逐项问不预设） */
export interface RequirementQuestion {
  id: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6' | 'Q7' | 'Q8';
  key: string;
  question: string;
  severity: 'blocking' | 'defaultable' | 'collect';
  /** 输入契约编号（I1–I7，方法论 0.2） */
  contract: string;
}

export const REQUIREMENT_QUESTIONS: RequirementQuestion[] = [
  { id: 'Q1', key: 'courseMeta', question: '课程名 / 章节题名 / 主讲是谁？', severity: 'blocking', contract: 'I7' },
  { id: 'Q2', key: 'knowledgeStructure', question: '节号体系与知识点清单、重点难点是什么？', severity: 'blocking', contract: 'I1' },
  { id: 'Q3', key: 'abstractCollection', question: '用哪本摘要集？PDF 在哪？（扫描件需先声明 OCR 降级）', severity: 'blocking', contract: 'I2' },
  { id: 'Q4', key: 'template', question: '用默认模板还是提供本校模板？', severity: 'defaultable', contract: 'I3' },
  { id: 'Q5', key: 'teachingParams', question: '课时、学情、先修、是否双面印发？', severity: 'collect', contract: 'I4' },
  { id: 'Q6', key: 'depthAndPlan', question: '要不要深化、深化到什么程度？教案要什么形态？', severity: 'collect', contract: 'I4' },
  { id: 'Q7', key: 'casePreferences', question: '案例怎么组织？课堂引入标签数量？篇数有没有取向？', severity: 'collect', contract: 'I5' },
  { id: 'Q8', key: 'extraOutputs', question: '默认四件套之外还要可编辑演示稿、打印校验件吗？', severity: 'collect', contract: 'I6' },
];

/** 用户纠偏（一次「不是这样」即一条，方法论 1.3 登记表字段） */
export interface CorrectionInput {
  quote?: unknown;
  content?: unknown;
  layer?: unknown;
  artifacts?: unknown;
  regression?: unknown;
  effectiveVersion?: unknown;
}

export interface ConstraintEntry {
  id: string;
  version: number;
  quote: string;
  layer: 'H' | 'P';
  /** 可判定的祈使句（方法论 1.3：不是描述，是能判真假的指令句） */
  content: string;
  artifacts: string[];
  regression: string;
  effectiveVersion: string;
  status: 'active';
}

export interface GatherRequirementsInput {
  answers?: unknown;
  priorAnswers?: unknown;
  confirmedCarryOver?: unknown;
  corrections?: unknown;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function answered(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  return true;
}

/** 项目个性信号词：命中则约束归 P（换一门课可能变）；拿不准归 P（方法论 1.2 判据） */
const PROJECT_SIGNALS = [
  /[0-9０-９]/,
  /第\s*[0-9０-９一二三四五六七八九十]+\s*[章讲节]/, /[章讲]\s*[0-9０-９]/,
  /篇|页/, /模板|校徽|配色|比例|字体/,
  /封面|页眉|页脚/, /题名|主讲|日期|年份/, /双面|单面|印发/,
] as const;

/** 通用硬约束信号词：教学法与产物边界类表述，换课程仍成立（H1 学生信息边界、H2 来源、H6 零外链…） */
const UNIVERSAL_SIGNALS = [
  /学生(可见|材料)/,
  /不得出现|不允许出现|禁止出现|不得包含/,
  /(不补造|未提供|零外链|离线|照录|禁用词|占位符|覆盖回归)/,
  /(来源|编号|术语|参考文献).{0,10}(未提供|一致|一次|对应|不补)/,
] as const;

/** 约束分层判定：显式 layer 优先；auto 时通用信号命中且项目信号未命中→H，否则→P */
export function classifyConstraint(content: string, layer?: string): 'H' | 'P' | { error: string } {
  if (layer !== undefined) {
    if (layer === 'H' || layer === 'P') return layer;
    return { error: `layer 须为 "H" | "P" | "auto"：${String(layer)}` };
  }
  const projectHit = PROJECT_SIGNALS.some((re) => re.test(content));
  const universalHit = UNIVERSAL_SIGNALS.some((re) => re.test(content));
  return universalHit && !projectHit ? 'H' : 'P';
}

export type RequirementsPlan =
  | { ok: true; answers: Record<string, unknown>; prior: Record<string, unknown>; confirmed: Set<string>; corrections: CorrectionInput[] }
  | { ok: false; error: string };

export function planRequirements(input: GatherRequirementsInput): RequirementsPlan {
  const answers = isObj(input.answers) ? input.answers : {};
  const prior = isObj(input.priorAnswers) ? input.priorAnswers : {};
  const confirmed = new Set(
    Array.isArray(input.confirmedCarryOver)
      ? input.confirmedCarryOver.filter((x): x is string => typeof x === 'string')
      : [],
  );
  const corrections = Array.isArray(input.corrections) ? (input.corrections as CorrectionInput[]) : [];
  for (const [i, c] of corrections.entries()) {
    if (!isObj(c)) return { ok: false, error: `corrections[${i}] 须为对象 { quote, content, ... }` };
    if (typeof c.quote !== 'string' || !c.quote.trim()) return { ok: false, error: `corrections[${i}].quote 必填（用户原话摘录）` };
    if (typeof c.content !== 'string' || !c.content.trim()) return { ok: false, error: `corrections[${i}].content 必填（可判定祈使句，如「课堂前沿拓展只保留一页引入标签」）` };
    const layer = classifyConstraint(c.content.trim(), typeof c.layer === 'string' ? c.layer : undefined);
    if (typeof layer !== 'string') return { ok: false, error: `corrections[${i}]：${layer.error}` };
  }
  return { ok: true, answers, prior, confirmed, corrections };
}

export interface ChecklistItem {
  id: string;
  key: string;
  question: string;
  contract: string;
  severity: 'blocking' | 'defaultable' | 'collect';
  status: 'answered' | 'missing';
  answer?: unknown;
  /** 本轮未答但上一轮有值：建议沿用，须明确复述请用户确认（方法论 0.3 迭代例外） */
  carriedOver?: { prior: unknown; needsRestate: boolean };
  /** 本轮回答与上轮不同：显式标出供确认，防静默改口径 */
  changed?: { prior: unknown };
}

export interface RequirementsReport {
  checklist: ChecklistItem[];
  /** 任一必问项未答即 true（方法论：不预设、不猜测、逐项问） */
  stopWork: boolean;
  /** 缺答的停工项（Q1–Q3，必需输入，不自行编造） */
  blockingMissing: string[];
  /** 缺答的采集项（Q5–Q8，逐项问） */
  toCollect: string[];
  /** 使用了默认且不阻断的项（当前仅 Q4 模板默认契约） */
  assumptionsUsed: { questionId: string; note: string }[];
  constraintRegistry: ConstraintEntry[];
  /** 纠偏回放：下一版开工自动逐条确认，防旧口径复活（方法论 1.4 第 6 步） */
  replay: { id: string; content: string; layer: 'H' | 'P'; status: 'active' }[];
}

/** 主流程：清单校验 + 沿用/变更标注 + 纠偏登记（登记表字段同方法论附录 B） */
export function buildRequirementsReport(input: GatherRequirementsInput): RequirementsReport | { error: string } {
  const plan = planRequirements(input);
  if (!plan.ok) return { error: plan.error };
  const { answers, prior, confirmed, corrections } = plan;

  const checklist: ChecklistItem[] = REQUIREMENT_QUESTIONS.map((q) => {
    const cur = answers[q.key];
    const hasCur = answered(cur);
    const pri = prior[q.key];
    const hasPri = answered(pri);
    const item: ChecklistItem = {
      id: q.id,
      key: q.key,
      question: q.question,
      contract: q.contract,
      severity: q.severity,
      status: hasCur ? 'answered' : 'missing',
    };
    if (hasCur) {
      item.answer = cur;
      if (hasPri && JSON.stringify(cur) !== JSON.stringify(pri)) item.changed = { prior: pri };
    } else if (hasPri) {
      item.carriedOver = { prior: pri, needsRestate: !confirmed.has(q.id) };
    }
    return item;
  });

  const blockingMissing = checklist.filter((i) => i.severity === 'blocking' && i.status === 'missing').map((i) => i.id);
  const toCollect = checklist.filter((i) => i.severity === 'collect' && i.status === 'missing').map((i) => i.id);
  const assumptionsUsed = checklist
    .filter((i) => i.severity === 'defaultable' && i.status === 'missing')
    .map((i) => ({ questionId: i.id, note: `${i.key} 未答：用默认模板契约，开工时须明确复述请用户确认` }));

  const registry: ConstraintEntry[] = corrections.map((c, i) => {
    const content = (c.content as string).trim();
    const layer = classifyConstraint(content, typeof c.layer === 'string' ? c.layer : undefined) as 'H' | 'P';
    return {
      id: `C${i + 1}`,
      version: i + 1,
      quote: (c.quote as string).trim(),
      layer,
      content,
      artifacts: Array.isArray(c.artifacts) ? c.artifacts.filter((a): a is string => typeof a === 'string') : [],
      regression: typeof c.regression === 'string' ? c.regression : '',
      effectiveVersion: typeof c.effectiveVersion === 'string' ? c.effectiveVersion : String(i + 1),
      status: 'active',
    };
  });

  return {
    checklist,
    stopWork: checklist.some((i) => i.status === 'missing'),
    blockingMissing,
    toCollect,
    assumptionsUsed,
    constraintRegistry: registry,
    replay: registry.map(({ id, content, layer, status }) => ({ id, content, layer, status })),
  };
}
