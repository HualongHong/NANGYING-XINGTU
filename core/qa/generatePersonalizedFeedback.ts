/**
 * 个性化反馈（generate_personalized_feedback）——N2 收尾切片。
 *
 * 输入：测验结果（按概念计分）+ 课程知识图谱（定位薄弱概念与根因）
 * + 可选问答库（补救建议引用）+ 可选 ctx（LLM 注入点）。
 *
 * 启发式默认即契约"通用模板反馈"语义：按概念正确率统计（<60% 标薄弱）、
 * 沿 prerequisite 边追溯薄弱根因、模板化评语与建议。
 * LLM 注入时生成自然语言评语；失败回落模板并标 degraded。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import type { CourseKnowledgeGraph } from '../graph/extractKnowledgeGraph.js';
import type { QaKnowledgeBase } from './buildQaKnowledgeBase.js';

export const GENERATE_PERSONALIZED_FEEDBACK_ID = 'generate_personalized_feedback';

/** 测验作答（每题一条） */
export interface QuizAnswer {
  conceptId: string;
  correct: boolean;
  questionId?: string;
}

/** 输入：测验结果 + 图谱 + 可选问答库；或 freeTextReport 自由文本报告模式（R5-5.3） */
export interface GenerateFeedbackInput {
  quiz?: {
    learnerId?: string;
    answers: QuizAnswer[];
  };
  graph?: CourseKnowledgeGraph;
  qaKnowledgeBase?: QaKnowledgeBase;
  /** 学生实验报告等自由文本：与 quiz 二选一（或并存）；产出段落级反馈 */
  freeTextReport?: string;
}

/** 单概念表现分析 */
export interface ConceptPerformance {
  conceptId: string;
  label: string;
  total: number;
  correct: number;
  accuracy: number;
  weak: boolean;
  /** 根因：同为薄弱的先修概念 */
  weakPrerequisites: string[];
}

export interface FeedbackSuggestion {
  kind: 'review_concept' | 'prerequisite_repair' | 'qa_practice' | 'path_hint';
  conceptIds: string[];
  text: string;
}

export interface FeedbackReport {
  /** 总体评价（LLM 评语或模板评语） */
  feedback: string;
  /** 按概念分组的表现分析 */
  conceptAnalysis: ConceptPerformance[];
  /** 针对性建议 */
  suggestions: FeedbackSuggestion[];
  /** 总体正确率与得分档 */
  overall: { total: number; correct: number; accuracy: number; band: 'excellent' | 'pass' | 'weak' };
  /** 自由文本报告段落级反馈（R5-5.3，freeTextReport 提供时给出） */
  freeTextFeedback?: {
    paragraphs: Array<{
      index: number;
      /** 段落摘录（≤60 字） */
      excerpt: string;
      /** 段落评语 */
      comment: string;
      /** 待改进点 */
      issues: string[];
    }>;
  };
}

const WEAK_THRESHOLD = 0.6;

// ---------- 启发式分析 ----------

export function analyzePerformance(input: { quiz: { answers: QuizAnswer[] }; graph: CourseKnowledgeGraph }): {
  analysis: ConceptPerformance[];
  overall: FeedbackReport['overall'];
} {
  const { graph, quiz } = input;
  const topo = graph.prerequisiteGraph.topoOrder;
  const labelOf = new Map(graph.entities.map((e) => [e.id, e.label]));
  const stat = new Map<string, { total: number; correct: number }>();
  for (const a of quiz.answers) {
    const s = stat.get(a.conceptId) ?? { total: 0, correct: 0 };
    s.total += 1;
    if (a.correct) s.correct += 1;
    stat.set(a.conceptId, s);
  }

  // 先修邻接：concept -> 其先修概念
  const prereqOf = new Map<string, string[]>();
  for (const e of graph.relations) {
    if (e.type === 'prerequisite' && e.from.startsWith('con-') && e.to.startsWith('con-')) {
      prereqOf.set(e.to, [...(prereqOf.get(e.to) ?? []), e.from]);
    }
  }

  const analysis: ConceptPerformance[] = [...stat.entries()]
    .map(([conceptId, s]) => {
      const accuracy = s.total === 0 ? 0 : s.correct / s.total;
      const weak = accuracy < WEAK_THRESHOLD;
      const weakPrereqs = weak
        ? (prereqOf.get(conceptId) ?? []).filter((p) => {
            const ps = stat.get(p);
            return ps !== undefined && ps.correct / ps.total < WEAK_THRESHOLD;
          })
        : [];
      return {
        conceptId,
        label: labelOf.get(conceptId) ?? conceptId,
        total: s.total,
        correct: s.correct,
        accuracy,
        weak,
        weakPrerequisites: weakPrereqs,
      };
    })
    .sort((a, b) => topo.indexOf(a.conceptId) - topo.indexOf(b.conceptId));

  const total = quiz.answers.length;
  const correct = quiz.answers.filter((a) => a.correct).length;
  const accuracy = total === 0 ? 0 : correct / total;
  const band = accuracy >= 0.85 ? 'excellent' : accuracy >= WEAK_THRESHOLD ? 'pass' : 'weak';
  return { analysis, overall: { total, correct, accuracy, band } };
}

function templateFeedback(
  analysis: ConceptPerformance[],
  overall: FeedbackReport['overall'],
): string {
  if (overall.total === 0) return '暂无测验作答记录，无法生成反馈。';
  const weakLabels = analysis.filter((a) => a.weak).map((a) => a.label);
  const bandText =
    overall.band === 'excellent' ? '表现优秀，继续保持！'
    : overall.band === 'pass' ? '整体掌握良好，仍有提升空间。'
    : '整体掌握不够牢固，建议系统复习。';
  const weakText = weakLabels.length > 0
    ? `薄弱知识点：${weakLabels.join('、')}。`
    : '各考查知识点均无薄弱项。';
  return `本次测验正确率 ${(overall.accuracy * 100).toFixed(0)}%（${overall.correct}/${overall.total}）。${bandText}${weakText}`;
}

/** 自由文本报告段落级启发式反馈（确定性） */
export function templateFreeTextFeedback(report: string): NonNullable<FeedbackReport['freeTextFeedback']> {
  const paragraphs = report
    .split(/\n+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 10);
  return {
    paragraphs: paragraphs.map((text, index) => {
      const issues: string[] = [];
      if (text.length < 40) issues.push('段落偏短：建议补充依据或细节');
      if (!/[。！？]/.test(text.slice(-1))) issues.push('句末标点缺失或句子不完整');
      if (!/\d/.test(text)) issues.push('缺少数据支撑：建议给出观测值或出处');
      if (/大概|差不多|也许|可能很/.test(text)) issues.push('表述含糊：建议改为可核验的定量描述');
      const comment = issues.length === 0
        ? '本段结构完整、表述清晰，保持了实验记录的客观性。'
        : `本段已完成基本记述，可进一步提升：${issues.join('；')}。`;
      return {
        index,
        excerpt: text.length > 60 ? text.slice(0, 60) + '…' : text,
        comment,
        issues,
      };
    }),
  };
}
function buildSuggestions(
  analysis: ConceptPerformance[],
  input: { graph: CourseKnowledgeGraph; qaKnowledgeBase?: QaKnowledgeBase },
): FeedbackSuggestion[] {
  const suggestions: FeedbackSuggestion[] = [];
  const weak = analysis.filter((a) => a.weak);
  for (const w of weak) {
    suggestions.push({
      kind: 'review_concept',
      conceptIds: [w.conceptId],
      text: `复习概念"${w.label}"（正确率 ${(w.accuracy * 100).toFixed(0)}%）。`,
    });
    for (const p of w.weakPrerequisites) {
      const pl = analysis.find((a) => a.conceptId === p);
      suggestions.push({
        kind: 'prerequisite_repair',
        conceptIds: [p, w.conceptId],
        text: `"${w.label}"薄弱可能源于先修概念"${pl?.label ?? p}"掌握不牢，建议先回炉基础。`,
      });
    }
  }
  // 问答库补救推荐：覆盖薄弱概念的前 3 条问答
  if (input.qaKnowledgeBase) {
    for (const w of weak.slice(0, 3)) {
      const related = input.qaKnowledgeBase.qaPairs
        .filter((q) => q.conceptIds.includes(w.conceptId))
        .slice(0, 3);
      for (const qa of related) {
        suggestions.push({
          kind: 'qa_practice',
          conceptIds: [w.conceptId],
          text: `推荐练习问答：${qa.question}（参考：${qa.answer.slice(0, 40)}${qa.answer.length > 40 ? '…' : ''}）`,
        });
      }
    }
  }
  // 路径提示：按 topoOrder 给出薄弱概念的先后复习次序
  if (weak.length > 1) {
    const topo = input.graph.prerequisiteGraph.topoOrder;
    const ordered = [...weak].sort((a, b) => topo.indexOf(a.conceptId) - topo.indexOf(b.conceptId));
    suggestions.push({
      kind: 'path_hint',
      conceptIds: ordered.map((w) => w.conceptId),
      text: `建议按先修顺序复习：${ordered.map((w) => w.label).join(' → ')}。`,
    });
  }
  return suggestions;
}

// ---------- 主入口 ----------

export async function generatePersonalizedFeedback(
  input: GenerateFeedbackInput,
  ctx: SkillContext = {},
): Promise<SkillResult<FeedbackReport>> {
  const freeTextMode = typeof input.freeTextReport === 'string' && input.freeTextReport.trim().length > 0;
  const quizMode = input.quiz && Array.isArray(input.quiz.answers);
  if (!quizMode && !freeTextMode) {
    return {
      skillId: GENERATE_PERSONALIZED_FEEDBACK_ID,
      level: 'unavailable',
      errorCode: 'INVALID_INPUT',
      degradationNote: '输入校验失败：quiz.answers + graph 为必需，或提供 freeTextReport 自由文本',
      example: '{ "freeTextReport": "实验目的是……" }',
    };
  }
  // freeText 模式（可无 quiz/graph）：段落级反馈，LLM 可用时精炼
  if (freeTextMode && !quizMode) {
    let level: 'full' | 'degraded' = 'full';
    let note = '';
    let ft = templateFreeTextFeedback(input.freeTextReport!);
    if (ctx.llm) {
      try {
        const prompt = [
          '你是实验报告批改助手。以下是学生报告的段落列表（JSON）：',
          JSON.stringify(ft.paragraphs.map((pp) => ({ index: pp.index, excerpt: pp.excerpt }))),
          '请为每段给出一句具体、建设性的中文评语（指出优点或改进点），严格以 JSON 字符串数组返回，顺序一致，只输出 JSON 数组本身。',
        ].join('\n');
        const raw = (await ctx.llm.complete(prompt, { temperature: 0.4 })).trim();
        const parsed: unknown = JSON.parse(raw.replace(/^\``(?:json)?\s*|\s*\``$/g, ''));
        if (!Array.isArray(parsed) || parsed.length !== ft.paragraphs.length) throw new Error('长度不匹配');
        const comments = parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
        if (comments.length !== ft.paragraphs.length) throw new Error('存在空评语');
        ft = { paragraphs: ft.paragraphs.map((pp, i) => ({ ...pp, comment: comments[i] })) };
      } catch {
        level = 'degraded';
        note = 'LLM 段落评语失败，已回落模板反馈';
      }
    }
    return {
      skillId: GENERATE_PERSONALIZED_FEEDBACK_ID,
      level,
      data: {
        feedback: `已审阅报告 ${ft.paragraphs.length} 段：共 ${ft.paragraphs.reduce((n, pp) => n + pp.issues.length, 0)} 个待改进点，详见 freeTextFeedback。`,
        conceptAnalysis: [],
        suggestions: [],
        overall: { total: 0, correct: 0, accuracy: 0, band: 'weak' as const },
        freeTextFeedback: ft,
      },
      degradationNote: note,
    };
  }
  const { analysis, overall } = analyzePerformance(input as { quiz: { answers: QuizAnswer[] }; graph: CourseKnowledgeGraph });
  const suggestions = buildSuggestions(analysis, input as { graph: CourseKnowledgeGraph; qaKnowledgeBase?: QaKnowledgeBase });

  let feedback = templateFeedback(analysis, overall);
  let level: 'full' | 'degraded' = 'full';
  let note = '';

  if (ctx.llm && overall.total > 0) {
    const prompt = [
      '你是教学反馈助手。请根据以下测验表现分析生成一段简短、鼓励性的中文评语（不超过 120 字）：',
      JSON.stringify({
        overall,
        concepts: analysis.map((a) => ({
          label: a.label,
          accuracy: a.accuracy,
          weak: a.weak,
          weakPrerequisites: a.weakPrerequisites,
        })),
      }),
      '只输出评语文本本身。',
    ].join('\n');
    try {
      const text = (await ctx.llm.complete(prompt, { temperature: 0.5 })).trim();
      if (!text) throw new Error('LLM 返回为空');
      feedback = text;
    } catch {
      level = 'degraded';
      note = 'LLM 评语生成失败，已回落模板反馈';
    }
  }

  return {
    skillId: GENERATE_PERSONALIZED_FEEDBACK_ID,
    level,
    data: {
      feedback,
      conceptAnalysis: analysis,
      suggestions,
      overall,
      // quiz + freeTextReport 并存时附段落级反馈（模板形态，LLM 评语聚焦总体）
      ...(freeTextMode ? { freeTextFeedback: templateFreeTextFeedback(input.freeTextReport!) } : {}),
    },
    degradationNote: note,
  };
}
