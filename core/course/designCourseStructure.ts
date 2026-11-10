/**
 * 智慧课程结构设计（design_course_structure）——M1 切片。
 *
 * 输入：extract_knowledge_graph 的课程知识图谱 + 结构化教学目标。
 * 输出：课程脚本（编排 + 时间分配）、教学结构（模块→课时→环节）、授课流程。
 *
 * 启发式默认（即契约所称"模板化结构"，语义自洽）：
 *  - 模块 = 章节层级树根节点，模块名由章节标题派生；
 *  - 课时 = 章节（保留先修顺序），知识点按拓扑序等比分桶进课时，
 *    并对先修边做"后继课时必须更靠后"的修正；
 *  - 时长按课时内容量估算，并在给定总时长约束下等比缩放取整；
 *  - 环节固定模板：导入→讲解→示例→练习→小结。
 * LLM 注入时增强模块命名、课时目标与衔接语；失败回落启发式并标 degraded。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import type { CourseKnowledgeGraph } from '../graph/extractKnowledgeGraph.js';

export const DESIGN_COURSE_STRUCTURE_ID = 'design_course_structure';

/** 结构化教学目标（契约中 teachingObjectives 的明确形态） */
export interface TeachingObjectives {
  /** 受众，如"本科生" */
  audience: string;
  /** 课程总时长约束（分钟）；缺省时按内容量自由估算 */
  totalMinutes?: number;
  /** 教学目标条目（LLM 增强课时目标表述时的输入） */
  objectives?: string[];
}

/** 课型（R3-4，反馈 c P1：实验/混合课型影响环节模板） */
export type CourseType = 'lecture' | 'lab' | 'hybrid';

export interface DesignCourseStructureInput {
  graph: CourseKnowledgeGraph;
  objectives: TeachingObjectives;
  /** 先备知识：学生已掌握的概念（标签或节点 ID，可选）——
   *  保留在先修链引用中，但不进测评点（lesson.priorConceptIds 标注） */
  priorKnowledge?: string[];
  /** 课型（可选，缺省 lecture 讲授模板，行为与旧版一致） */
  courseType?: CourseType;
  /** 交付物清单（可选）：回声进 courseScript.deliverables，供下游导出对齐 */
  deliverables?: string[];
}

export type PhaseKind = '导入' | '讲解' | '示例' | '练习' | '小结';

export interface LessonPhase {
  kind: PhaseKind;
  minutes: number;
  /** 本环节涉及的知识点节点 ID（上游确定性 ID） */
  conceptIds: string[];
  /** 衔接语（LLM 增强产物） */
  transition?: string;
}

export interface Lesson {
  id: string;
  title: string;
  moduleId: string;
  /** 本课时引用的章节节点 ID */
  sectionIds: string[];
  /** 本课时覆盖的知识点节点 ID（星图可追溯） */
  conceptIds: string[];
  minutes: number;
  phases: LessonPhase[];
  /** 测评点（覆盖的知识点标签） */
  assessmentPoints: string[];
  /** 先备知识引用（priorKnowledge 命中的概念 ID：保留在先修链中但不作本课测评点） */
  priorConceptIds?: string[];
  /** 课时目标（LLM 增强产物） */
  objective?: string;
}

export interface CourseModule {
  id: string;
  /** 模块名（由章节标题派生，LLM 可增强） */
  title: string;
  /** 本模块覆盖的章节节点 ID */
  sectionIds: string[];
  lessons: Lesson[];
  minutes: number;
}

export interface FlowStep {
  id: string;
  lessonId: string;
  phase: PhaseKind;
  conceptIds: string[];
}

export interface CourseStructure {
  /** 课程总体脚本：标题、总时长、模块编排与时间分配 */
  courseScript: {
    title: string;
    audience: string;
    totalMinutes: number;
    modules: Array<{ id: string; title: string; minutes: number; lessonIds: string[] }>;
    /** 先备知识回声（priorKnowledge 提供时） */
    priorKnowledge?: string[];
    /** 课型回声（courseType 提供时） */
    courseType?: CourseType;
    /** 交付物清单回声（deliverables 提供时） */
    deliverables?: string[];
  };
  /** 教学结构：模块 → 课时 → 环节 */
  teachingStructure: CourseModule[];
  /** 授课流程：环节顺序与衔接关系 */
  teachingFlow: { steps: FlowStep[]; edges: Array<{ from: string; to: string }> };
}

// ---------- 确定性 ID ----------

function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// ---------- 启发式编排 ----------

const PHASE_TEMPLATE: Array<{ kind: PhaseKind; ratio: number }> = [
  { kind: '导入', ratio: 0.1 },
  { kind: '讲解', ratio: 0.4 },
  { kind: '示例', ratio: 0.2 },
  { kind: '练习', ratio: 0.2 },
  { kind: '小结', ratio: 0.1 },
];

/** 课型环节模板（R3-4）：讲授（默认）/ 实验（操作加量）/ 混合（折中）；环节枚举不变 */
const COURSE_TYPE_TEMPLATES: Record<CourseType, typeof PHASE_TEMPLATE> = {
  lecture: PHASE_TEMPLATE,
  lab: [
    { kind: '导入', ratio: 0.1 },
    { kind: '讲解', ratio: 0.15 },
    { kind: '示例', ratio: 0.25 },
    { kind: '练习', ratio: 0.4 },
    { kind: '小结', ratio: 0.1 },
  ],
  hybrid: [
    { kind: '导入', ratio: 0.1 },
    { kind: '讲解', ratio: 0.3 },
    { kind: '示例', ratio: 0.25 },
    { kind: '练习', ratio: 0.25 },
    { kind: '小结', ratio: 0.1 },
  ],
};

/** 把课时分钟数按模板比例切分为各环节（每项至少 1 分钟，误差归入讲解） */
export function splitPhases(
  minutes: number,
  conceptIds: string[],
  template: typeof PHASE_TEMPLATE = PHASE_TEMPLATE,
): LessonPhase[] {
  const parts = template.map((p) => ({
    kind: p.kind,
    minutes: Math.max(1, Math.round(minutes * p.ratio)),
  }));
  const diff = minutes - parts.reduce((s, p) => s + p.minutes, 0);
  const lectureIdx = parts.findIndex((p) => p.kind === '讲解');
  const absorb = parts[lectureIdx >= 0 ? lectureIdx : 1];
  absorb.minutes = Math.max(1, absorb.minutes + diff);
  return parts.map((p) => ({
    ...p,
    conceptIds: p.kind === '导入' ? [] : conceptIds,
  }));
}

/** 空图谱降级：契约模板骨架（导入—讲解—练习—总结） */
function templateSkeleton(objectives: TeachingObjectives): CourseStructure {
  const total = objectives.totalMinutes ?? 45;
  const kinds: PhaseKind[] = ['导入', '讲解', '练习', '小结'];
  const lesson: Lesson = {
    id: `les-${stableHash('les:0:0:课程总览')}`,
    title: '课程总览',
    moduleId: `mod-${stableHash('mod:课程总览')}`,
    sectionIds: [],
    conceptIds: [],
    minutes: total,
    phases: kinds.map((kind) => ({ kind, minutes: Math.max(1, Math.round(total / 4)), conceptIds: [] })),
    assessmentPoints: [],
  };
  const module: CourseModule = {
    id: `mod-${stableHash('mod:课程总览')}`,
    title: '课程总览',
    sectionIds: [],
    lessons: [lesson],
    minutes: total,
  };
  return {
    courseScript: {
      title: '课程总览',
      audience: objectives.audience,
      totalMinutes: total,
      modules: [{ id: module.id, title: module.title, minutes: total, lessonIds: [lesson.id] }],
    },
    teachingStructure: [module],
    teachingFlow: {
      steps: lesson.phases.map((p, i) => ({
        id: `step-${i}`,
        lessonId: lesson.id,
        phase: p.kind,
        conceptIds: [],
      })),
      edges: lesson.phases.slice(1).map((_, i) => ({ from: `step-${i}`, to: `step-${i + 1}` })),
    },
  };
}

interface DraftLesson {
  title: string;
  sectionIds: string[];
  conceptIds: string[];
}

/** 主入口：设计课程结构 */
export async function designCourseStructure(
  input: DesignCourseStructureInput,
  ctx: SkillContext = {},
): Promise<SkillResult<CourseStructure>> {
  const { graph, objectives } = input;
  // R3-4 可选参数（缺省行为与旧版逐字节一致）
  const priorKnown = new Set(input.priorKnowledge ?? []);
  const courseType: CourseType =
    input.courseType === 'lab' || input.courseType === 'hybrid' ? input.courseType : 'lecture';
  const phaseTemplate = COURSE_TYPE_TEMPLATES[courseType];
  const hasContent =
    graph.hierarchy.length > 0 || graph.entities.length > 0 ||
    graph.prerequisiteGraph.nodes.length > 0;

  if (!hasContent) {
    return {
      skillId: DESIGN_COURSE_STRUCTURE_ID,
      level: 'degraded',
      data: templateSkeleton(objectives),
      degradationNote: '知识图谱为空，已退化为模板化结构骨架',
    };
  }

  // 1) 模块分组：章节层级树根节点为一模块，模块名由章节标题派生
  const roots = graph.hierarchy;
  const sectionToModule = new Map<string, number>();
  roots.forEach((root, mi) => {
    const walk = (sec: typeof root) => {
      sectionToModule.set(sec.id, mi);
      sec.children.forEach(walk);
    };
    walk(root);
  });

  // 2) 课时草稿：每个章节一个课时（无章节时按概念每 5 个一课时）
  const concepts = [...graph.entities].sort((a, b) => {
    const topo = graph.prerequisiteGraph.topoOrder;
    const ia = topo.indexOf(a.id);
    const ib = topo.indexOf(b.id);
    return (ia === -1 ? a.order : ia) - (ib === -1 ? b.order : ib);
  });
  const flatSections: Array<{ id: string; title: string; order: number; moduleIdx: number }> = [];
  roots.forEach((root, mi) => {
    const walk = (sec: typeof root) => {
      flatSections.push({ id: sec.id, title: sec.title, order: sec.order, moduleIdx: mi });
      sec.children.forEach(walk);
    };
    walk(root);
  });
  flatSections.sort((a, b) => a.order - b.order);

  let drafts: DraftLesson[];
  if (flatSections.length > 0) {
    drafts = flatSections.map((s) => ({ title: s.title, sectionIds: [s.id], conceptIds: [] }));
  } else {
    const chunks: typeof concepts[] = [];
    for (let i = 0; i < concepts.length; i += 5) chunks.push(concepts.slice(i, i + 5));
    drafts = chunks.map((chunk, i) => ({
      title: `主题 ${i + 1}`,
      sectionIds: [],
      conceptIds: [],
    }));
  }

  // 3) 知识点按拓扑序等比分桶进课时（保持单调，先修在前）
  if (concepts.length > 0 && drafts.length > 0) {
    concepts.forEach((c, k) => {
      const idx = Math.min(drafts.length - 1, Math.floor((k * drafts.length) / concepts.length));
      drafts[idx].conceptIds.push(c.id);
    });
  }
  // 先修修正：后继课时必须严格更靠后
  const lessonOf = new Map<string, number>();
  const locate = () => {
    lessonOf.clear();
    drafts.forEach((d, i) => d.conceptIds.forEach((cid) => lessonOf.set(cid, i)));
  };
  locate();
  const conceptPrereqs = graph.relations.filter(
    (e) => e.type === 'prerequisite' && e.from.startsWith('con-') && e.to.startsWith('con-'),
  );
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const e of conceptPrereqs) {
      const lf = lessonOf.get(e.from);
      const lt = lessonOf.get(e.to);
      if (lf === undefined || lt === undefined) continue;
      if (lt <= lf) {
        const target = Math.min(drafts.length - 1, lf + 1);
        drafts[lt].conceptIds = drafts[lt].conceptIds.filter((id) => id !== e.to);
        drafts[target].conceptIds.push(e.to);
        changed = true;
      }
    }
    locate();
    if (!changed) break;
  }

  // 4) 时长估算：内容量（概念数×5 + 基础 10）分钟，再按总时长约束缩放
  const raw = drafts.map((d) => 10 + 5 * d.conceptIds.length);
  const rawTotal = raw.reduce((s, v) => s + v, 0);
  let minutes: number[];
  if (objectives.totalMinutes && objectives.totalMinutes > 0) {
    const factor = objectives.totalMinutes / rawTotal;
    minutes = raw.map((v) => Math.max(1, Math.round(v * factor)));
    // 总量不超约束：从最大的课时往下扣
    let sum = minutes.reduce((s, v) => s + v, 0);
    while (sum > objectives.totalMinutes) {
      const maxIdx = minutes.indexOf(Math.max(...minutes));
      if (minutes[maxIdx] <= 1) break;
      minutes[maxIdx] -= 1;
      sum -= 1;
    }
  } else {
    minutes = raw;
  }

  // 5) 组装模块 → 课时 → 环节
  const modules: CourseModule[] = roots.map((root, mi) => ({
    id: `mod-${stableHash(`mod:${mi}:${root.title}`)}`,
    title: root.title,
    sectionIds: [root.id],
    lessons: [],
    minutes: 0,
  }));
  if (modules.length === 0) {
    modules.push({
      id: `mod-${stableHash('mod:0:课程主体')}`,
      title: '课程主体',
      sectionIds: [],
      lessons: [],
      minutes: 0,
    });
  }

  const lessons: Lesson[] = drafts.map((d, i) => {
    const moduleIdx = flatSections.length > 0
      ? (sectionToModule.get(d.sectionIds[0]) ?? 0)
      : 0;
    const conceptLabels = d.conceptIds.map(
      (cid) => graph.entities.find((e) => e.id === cid)?.label ?? cid,
    );
    // 先备知识（R3-4）：命中的概念保留在先修链（conceptIds 不动），
    // 但不作本课测评点——lesson.priorConceptIds 标注，assessmentPoints 排除
    const priorConceptIds = d.conceptIds.filter((cid, k) =>
      priorKnown.has(cid) || priorKnown.has(conceptLabels[k]),
    );
    const assessmentPoints = conceptLabels.filter(
      (_, k) => !priorConceptIds.includes(d.conceptIds[k]),
    );
    return {
      id: `les-${stableHash(`les:${moduleIdx}:${i}:${d.title}`)}`,
      title: d.title,
      moduleId: modules[moduleIdx].id,
      sectionIds: d.sectionIds,
      conceptIds: d.conceptIds,
      minutes: minutes[i],
      phases: splitPhases(minutes[i], d.conceptIds, phaseTemplate),
      assessmentPoints,
      ...(priorConceptIds.length > 0 ? { priorConceptIds } : {}),
    };
  });

  for (const lesson of lessons) {
    const mod = modules.find((m) => m.id === lesson.moduleId)!;
    mod.lessons.push(lesson);
  }
  for (const mod of modules) {
    mod.lessons.sort((a, b) => lessons.indexOf(a) - lessons.indexOf(b));
    mod.minutes = mod.lessons.reduce((s, l) => s + l.minutes, 0);
    mod.sectionIds = [...new Set(mod.lessons.flatMap((l) => l.sectionIds))];
  }

  const totalMinutes = lessons.reduce((s, l) => s + l.minutes, 0);

  // 6) LLM 增强：模块命名、课时目标、衔接语
  let level: 'full' | 'degraded' = 'full';
  let note = '';
  if (ctx.llm) {
    const prompt = [
      '你是课程设计助手。以下是一门课程的教学单元（JSON）：',
      JSON.stringify(
        modules.map((m) => ({
          module: m.title,
          lessons: m.lessons.map((l) => ({ title: l.title, points: l.assessmentPoints })),
        })),
      ),
      '请为每个模块给出更精炼的名称、为每个课时给出一句课时目标，并为每个课时给出一句承接上一课时的衔接语。',
      '严格以 JSON 返回：{"moduleTitles":["…"],"lessonObjectives":["…"],"transitions":["…"]}，数组长度须与输入一致，只输出 JSON 本身。',
    ].join('\n');
    try {
      const raw2 = (await ctx.llm.complete(prompt, { temperature: 0.4 })).trim();
      const cleaned = raw2.replace(/^```(?:json)?\s*|\s*```$/g, '');
      const parsed = JSON.parse(cleaned) as {
        moduleTitles?: unknown;
        lessonObjectives?: unknown;
        transitions?: unknown;
      };
      const modTitles = Array.isArray(parsed.moduleTitles) ? parsed.moduleTitles : [];
      const objectivesArr = Array.isArray(parsed.lessonObjectives) ? parsed.lessonObjectives : [];
      const transitions = Array.isArray(parsed.transitions) ? parsed.transitions : [];
      const strs = (arr: unknown[]) => arr.filter((x): x is string => typeof x === 'string');
      const mt = strs(modTitles);
      const lo = strs(objectivesArr);
      const tr = strs(transitions);
      if (mt.length !== modules.length || lo.length !== lessons.length || tr.length !== lessons.length) {
        throw new Error('LLM 返回长度不匹配');
      }
      modules.forEach((m, i) => { m.title = mt[i]; });
      lessons.forEach((l, i) => {
        l.objective = lo[i];
        l.phases[0].transition = tr[i];
      });
    } catch {
      level = 'degraded';
      note = 'LLM 结构增强失败，已回落启发式结构';
    }
  }

  // 7) 授课流程
  const steps: FlowStep[] = [];
  const edges: Array<{ from: string; to: string }> = [];
  let prev: string | null = null;
  for (const lesson of lessons) {
    for (const phase of lesson.phases) {
      const id = `step-${steps.length}`;
      steps.push({ id, lessonId: lesson.id, phase: phase.kind, conceptIds: phase.conceptIds });
      if (prev) edges.push({ from: prev, to: id });
      prev = id;
    }
  }

  return {
    skillId: DESIGN_COURSE_STRUCTURE_ID,
    level,
    data: {
      courseScript: {
        title: modules[0]?.title ?? '课程总览',
        audience: objectives.audience,
        totalMinutes,
        modules: modules.map((m) => ({
          id: m.id,
          title: m.title,
          minutes: m.minutes,
          lessonIds: m.lessons.map((l) => l.id),
        })),
        ...(input.priorKnowledge ? { priorKnowledge: input.priorKnowledge } : {}),
        ...(['lecture', 'lab', 'hybrid'].includes(input.courseType ?? '')
          ? { courseType: input.courseType } : {}),
        ...(input.deliverables ? { deliverables: input.deliverables } : {}),
      },
      teachingStructure: modules,
      teachingFlow: { steps, edges },
    },
    degradationNote: note,
  };
}
