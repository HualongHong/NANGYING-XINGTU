/**
 * 教学脚本生成（generate_teaching_script）——M1 闭环切片。
 *
 * 输入：design_course_structure 的课程结构 + 可选风格参数。
 * 输出：分镜级教学脚本（storyboardScript / voiceoverScript / subtitleScript），
 * 字幕与口播同源派生（字幕 = 口播按 scene 的时间切片文本）。
 *
 * 启发式默认：按课时五环节模板逐环节生成——口播为模板句 + 课时标题/
 * 知识点 label 组装；分镜场景类型由环节映射（含 PPT 展示轮换规则）；
 * 字幕按时长给出时码建议。
 * LLM 注入时改写口播稿为连贯讲授语言；失败回落启发式并标 degraded。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import type { CourseStructure, Lesson, PhaseKind } from './designCourseStructure.js';

export const GENERATE_TEACHING_SCRIPT_ID = 'generate_teaching_script';

/** 风格参数（契约未明确形态，结构化澄清） */
export interface ScriptStyle {
  /** 语言标识，默认 'zh' */
  language?: string;
  /** 详略度：brief 每条一句话；standard 基础模板；detailed 追加过渡句 */
  verbosity?: 'brief' | 'standard' | 'detailed';
}

export interface GenerateTeachingScriptInput {
  structure: CourseStructure;
  style?: ScriptStyle;
  /** 讲义原文直传（R3-5，反馈 c P1-4）：口播稿讲解/示例环节优先从原文取材，减少模板化 */
  sourceText?: string;
  /** 必含知识点清单（概念标签，可选）：输出 coverage 覆盖报告，标注未覆盖项 */
  requiredConcepts?: string[];
}

export type SceneType = '标题卡' | 'PPT展示' | '教师口播' | '示例演示' | '练习' | '小结';

export interface Scene {
  id: string;
  lessonId: string;
  phase: PhaseKind;
  sceneType: SceneType;
  /** 画面提示 */
  visual: string;
  /** 口播稿 */
  voiceover: string;
  /** 字幕稿（口播的时间切片文本，与口播同源派生） */
  subtitle: string;
  minutes: number;
  /** 课时内起始分钟（时码建议） */
  startMinute: number;
  /** 涉及的知识点节点 ID（上游确定性 ID） */
  conceptIds: string[];
}

export interface SubtitleCue {
  lessonId: string;
  sceneId: string;
  startMinute: number;
  minutes: number;
  text: string;
}

export interface TeachingScript {
  /** 分镜讲稿（镜头/画面提示 + 讲解词） */
  storyboardScript: Array<{ lessonId: string; title: string; scenes: Scene[] }>;
  /** 口播稿（纯语音朗读文本，按 scene 拼接） */
  voiceoverScript: Array<{ lessonId: string; title: string; text: string }>;
  /** 字幕稿（带时码建议的字幕文本） */
  subtitleScript: SubtitleCue[];
  /** 必含知识点覆盖报告（requiredConcepts 提供时给出；反馈 c P1 约束） */
  coverage?: {
    requiredConcepts: string[];
    coveredConcepts: string[];
    missingConcepts: string[];
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

// ---------- 启发式模板 ----------

/** 环节 → 场景类型映射（讲解有知识点用 PPT 展示，否则教师口播） */
function sceneTypeOf(phase: PhaseKind, conceptLabels: string[]): SceneType {
  switch (phase) {
    case '导入':
      return '标题卡';
    case '讲解':
      return conceptLabels.length > 0 ? 'PPT展示' : '教师口播';
    case '示例':
      return '示例演示';
    case '练习':
      return '练习';
    case '小结':
      return conceptLabels.length > 0 ? '小结' : '教师口播';
  }
}

function visualOf(sceneType: SceneType, lessonTitle: string, labels: string[]): string {
  const join = labels.join('、') || lessonTitle;
  switch (sceneType) {
    case '标题卡':
      return `画面：课程标题卡"${lessonTitle}"，配章节导航条`;
    case 'PPT展示':
      return `画面：PPT 展示${join}的结构示意图与要点条目`;
    case '教师口播':
      return `画面：教师中景口播，背景为${lessonTitle}主题板书`;
    case '示例演示':
      return `画面：演示${join}的具体例子，屏幕高亮关键步骤`;
    case '练习':
      return `画面：练习题卡，逐步展示题目与作答提示`;
    case '小结':
      return `画面：小结页，回顾${join}要点`;
  }
}

/** 口播模板句：模板 + 课时标题/知识点 label 组装，详略度控制句式数量 */
function voiceoverOf(
  phase: PhaseKind,
  lessonTitle: string,
  labels: string[],
  verbosity: 'brief' | 'standard' | 'detailed',
): string {
  const points = labels.join('、') || lessonTitle;
  const first = labels[0] ?? lessonTitle;
  const templates: Record<PhaseKind, { brief: string; standard: string; extra?: string }> = {
    导入: {
      brief: `同学们好，本节是"${lessonTitle}"。`,
      standard: `各位同学好，欢迎来到"${lessonTitle}"。本课时我们将围绕${points}展开学习。`,
    },
    讲解: {
      brief: `接下来我们看${first}。`,
      standard:
        labels.length > 0
          ? labels
              .map((l) => `接下来我们看${l}。${l}是本课时的重点内容，请结合画面理解其核心定义与作用。`)
              .join('')
          : `接下来我们讲解"${lessonTitle}"的核心内容。`,
      extra: '理解这一概念需要结合前面所学，注意辨析易混淆之处。',
    },
    示例: {
      brief: `下面看一个${first}的例子。`,
      standard: `下面通过一个例子说明${first}的应用场景，请跟随演示步骤观察其变化过程。`,
    },
    练习: {
      brief: `请完成一个与${first}相关的小练习。`,
      standard: `请同学们尝试完成一个与${first}相关的小练习，检验自己对本课时内容的理解。`,
    },
    小结: {
      brief: `本课时学习了${points}。`,
      standard: `本课时我们学习了${points}。请大家课后复习这些要点，并完成配套练习。`,
    },
  };
  const t = templates[phase];
  const base = verbosity === 'brief' ? t.brief : t.standard;
  return verbosity === 'detailed' && t.extra ? base + t.extra : base;
}

/** 讲义原文分句（确定性） */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？；\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
}

/** 从讲义原文中取 concept 的首个命中句（≤80 字），无命中返回 null */
function quoteFromSource(sourceSentences: string[], concept: string): string | null {
  if (!concept) return null;
  const hit = sourceSentences.find((s) => s.includes(concept));
  if (!hit) return null;
  const one = hit.split(/(?<=[。！？])/).find((s) => s.includes(concept)) ?? hit;
  return one.length > 80 ? one.slice(0, 80) + '…' : one;
}

/**
 * 口播取材（R3-5）：讲解/示例/小结环节若给出 sourceText，优先引用原文命中句
 * （"原文：…"），无命中回落模板句——减少"接下来我们看格局"式通用填空。
 */
function voiceoverWithSource(
  phase: PhaseKind,
  lessonTitle: string,
  labels: string[],
  verbosity: 'brief' | 'standard' | 'detailed',
  sourceSentences: string[],
): string {
  const base = voiceoverOf(phase, lessonTitle, labels, verbosity);
  if (phase === '练习' || verbosity === 'brief') return base;
  const quotes = labels
    .map((l) => quoteFromSource(sourceSentences, l))
    .filter((q): q is string => q !== null)
    .slice(0, 2);
  if (quotes.length === 0) return base;
  return `${base}原文参考：${quotes.join('')}`;
}

// ---------- 主入口 ----------

export async function generateTeachingScript(
  input: GenerateTeachingScriptInput,
  ctx: SkillContext = {},
): Promise<SkillResult<TeachingScript>> {
  const { structure, style } = input;
  const verbosity = style?.verbosity ?? 'standard';
  const sourceSentences = input.sourceText ? splitSentences(input.sourceText) : [];
  const labelOf = new Map<string, string>();
  // conceptId -> label 需要从上游图谱取；CourseStructure 未携带 label，
  // 测评点 assessmentPoints 与 conceptIds 同序，作为 label 来源
  const lessons: Lesson[] = structure.teachingStructure.flatMap((m) => m.lessons);

  if (lessons.length === 0) {
    return {
      skillId: GENERATE_TEACHING_SCRIPT_ID,
      level: 'degraded',
      data: { storyboardScript: [], voiceoverScript: [], subtitleScript: [] },
      degradationNote: '课程结构为空，已退化为空脚本',
    };
  }

  // 1) 逐课时逐环节生成分镜 scene
  interface Draft {
    lesson: Lesson;
    scene: Scene;
  }
  const drafts: Draft[] = [];
  for (const lesson of lessons) {
    let cursor = 0;
    lesson.phases.forEach((phase, phaseIdx) => {
      const labels = phase.conceptIds.map(
        (cid) =>
          labelOf.get(cid) ??
          lesson.assessmentPoints[lesson.conceptIds.indexOf(cid)] ??
          cid,
      );
      const sceneType = sceneTypeOf(phase.kind, labels);
      const voiceover = voiceoverWithSource(phase.kind, lesson.title, labels, verbosity, sourceSentences);
      drafts.push({
        lesson,
        scene: {
          id: `scene-${stableHash(`${lesson.id}:${phaseIdx}:${phase.kind}`)}`,
          lessonId: lesson.id,
          phase: phase.kind,
          sceneType,
          visual: visualOf(sceneType, lesson.title, labels),
          voiceover,
          subtitle: voiceover,
          minutes: phase.minutes,
          startMinute: cursor,
          conceptIds: phase.conceptIds,
        },
      });
      cursor += phase.minutes;
    });
  }

  // 2) LLM 增强：改写口播稿为连贯讲授语言（按 scene 顺序平铺）
  let level: 'full' | 'degraded' = 'full';
  let note = '';
  if (ctx.llm) {
    const prompt = [
      '你是教学脚本撰写助手。以下是一门课程的逐环节讲稿框架（JSON，scene 按授课顺序排列）：',
      JSON.stringify(
        drafts.map((d) => ({
          lesson: d.lesson.title,
          phase: d.scene.phase,
          points: d.scene.conceptIds.map(
            (cid) => d.lesson.assessmentPoints[d.lesson.conceptIds.indexOf(cid)] ?? cid,
          ),
          draft: d.scene.voiceover,
        })),
      ),
      input.sourceText
        ? '以下是与本课相关的讲义原文摘录，改写时请保持术语与事实和原文一致，不要杜撰：' +
          input.sourceText.slice(0, 2000)
        : '',
      '请把每个 scene 的 draft 改写为连贯自然的教师口播语言，保持知识点准确，篇幅与预计时长相称。',
      '严格以 JSON 字符串数组返回改写后的口播稿，顺序与输入一致，只输出 JSON 数组本身。',
    ].filter(Boolean).join('\n');
    try {
      const raw = (await ctx.llm.complete(prompt, { temperature: 0.6 })).trim();
      const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
      const parsed: unknown = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
      const texts = parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
      if (texts.length !== drafts.length) throw new Error('LLM 返回长度不匹配');
      drafts.forEach((d, i) => {
        d.scene.voiceover = texts[i];
        d.scene.subtitle = texts[i];
      });
    } catch {
      level = 'degraded';
      note = 'LLM 口播改写失败，已回落启发式模板稿';
    }
  }

  // 3) 组装三种成稿
  const storyboardScript = lessons.map((lesson) => ({
    lessonId: lesson.id,
    title: lesson.title,
    scenes: drafts.filter((d) => d.lesson === lesson).map((d) => d.scene),
  }));
  const voiceoverScript = lessons.map((lesson) => ({
    lessonId: lesson.id,
    title: lesson.title,
    text: drafts
      .filter((d) => d.lesson === lesson)
      .map((d) => d.scene.voiceover)
      .join('\n'),
  }));
  const subtitleScript: SubtitleCue[] = drafts.map((d) => ({
    lessonId: d.lesson.id,
    sceneId: d.scene.id,
    startMinute: d.scene.startMinute,
    minutes: d.scene.minutes,
    text: d.scene.subtitle,
  }));

  // 必含知识点覆盖校验（R3-5）：命中=某 scene 的知识点标签或课时标题覆盖
  let coverage: TeachingScript['coverage'];
  if (input.requiredConcepts && input.requiredConcepts.length > 0) {
    const taughtLabels = new Set<string>();
    for (const lesson of lessons) {
      for (const l of lesson.assessmentPoints) taughtLabels.add(l);
      for (const l of lesson.conceptIds.map((cid, k) => lesson.assessmentPoints[k] ?? cid)) {
        taughtLabels.add(l);
      }
    }
    const covered = input.requiredConcepts.filter((c) => taughtLabels.has(c));
    const missing = input.requiredConcepts.filter((c) => !taughtLabels.has(c));
    coverage = {
      requiredConcepts: input.requiredConcepts,
      coveredConcepts: covered,
      missingConcepts: missing,
    };
  }

  return {
    skillId: GENERATE_TEACHING_SCRIPT_ID,
    level,
    data: { storyboardScript, voiceoverScript, subtitleScript, ...(coverage ? { coverage } : {}) },
    degradationNote: note,
  };
}
