/**
 * 反馈文档模型：prepare（草稿）→ 用户审阅 → approve（入库）。
 * 审阅门是硬约束：buildAcceptedDocument 在 approved !== true 时拒绝产出文档。
 * 全部为确定性纯函数：docId/now 由调用方注入，便于测试与复现。
 */
import { sanitizeText, type Redaction } from './sanitize.js';

export type FeedbackKind = 'install_issue' | 'usage_issue' | 'praise' | 'not_used' | 'suggestion';

export const FEEDBACK_KINDS: readonly FeedbackKind[] = [
  'install_issue',
  'usage_issue',
  'praise',
  'not_used',
  'suggestion',
];

export const KIND_LABELS: Record<FeedbackKind, string> = {
  install_issue: '安装问题',
  usage_issue: '使用问题',
  praise: '满意执行（含未用插件）',
  not_used: '未使用插件的场景',
  suggestion: '改进建议',
};

export interface FeedbackDraftInput {
  kind: unknown;
  summary: unknown;
  detail?: unknown;
  context?: unknown;
  /** 显式命令：保留敏感信息（调试通道） */
  includeSensitive?: unknown;
  /** 用户显式提供的敏感片段；仅 includeSensitive=true 时收录 */
  sensitiveExcerpt?: unknown;
}

export interface FeedbackDraft {
  schema: 1;
  stage: 'draft';
  docId: string;
  createdAt: string;
  kind: FeedbackKind;
  kindLabel: string;
  summary: string;
  detail: string;
  context: string;
  /** 默认脱敏后的脱敏清单（summary/detail/context 已处理） */
  redactions: Redaction[];
  /** 敏感附件：仅用户显式命令时存在，原文保留并醒目标记 */
  sensitive?: { excerpt: string; note: string };
  /** 草稿未入库的硬说明 */
  reviewGate: string;
}

export interface AcceptedFeedback {
  schema: 1;
  docId: string;
  acceptedAt: string;
  kind: FeedbackKind;
  kindLabel: string;
  summary: string;
  detail: string;
  context: string;
  redactions: Redaction[];
  sensitive?: { excerpt: string; note: string };
  reviewComment?: string;
  source: 'submit_feedback';
}

export type FeedbackError = { error: string };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function toOptString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * prepare 阶段：构建默认脱敏的反馈草稿。绝不落盘——存储只发生在 approve 阶段。
 * - summary/detail/context 全量脱敏（含用户后编辑内容在 approve 再次脱敏兜底）；
 * - sensitiveExcerpt 仅在 includeSensitive 为 true 时收录进「敏感附件」段，否则忽略并注明；
 * - 校验失败返回 { error }，由执行器转 INVALID_INPUT。
 */
export function buildFeedbackDraft(
  input: FeedbackDraftInput,
  opts: { docId: string; now: string },
): FeedbackDraft | FeedbackError {
  if (!FEEDBACK_KINDS.includes(input.kind as FeedbackKind)) {
    return { error: `kind 非法：${String(input.kind)}；可选：${FEEDBACK_KINDS.join(' | ')}` };
  }
  if (!isNonEmptyString(input.summary)) {
    return { error: 'summary 必填（非空一句话标题，如"安装时 pnpm install 报 ERR_PNPM_IGNoRED_BUILDS"）' };
  }
  const redactions: Redaction[] = [];
  const collect = (r: { text: string; redactions: Redaction[] }) => {
    for (const red of r.redactions) {
      const existing = redactions.find((x) => x.type === red.type);
      if (existing) existing.count += red.count;
      else redactions.push({ ...red });
    }
    return r.text;
  };
  const summary = collect(sanitizeText(input.summary.trim()));
  const detail = collect(sanitizeText(toOptString(input.detail)));
  const context = collect(sanitizeText(toOptString(input.context)));

  const includeSensitive = input.includeSensitive === true || input.includeSensitive === 'true';
  const excerpt = toOptString(input.sensitiveExcerpt);
  const draft: FeedbackDraft = {
    schema: 1,
    stage: 'draft',
    docId: opts.docId,
    createdAt: opts.now,
    kind: input.kind as FeedbackKind,
    kindLabel: KIND_LABELS[input.kind as FeedbackKind],
    summary,
    detail,
    context,
    redactions,
    reviewGate:
      '草稿未入库：请审阅全部内容；确认无误后以 stage="approve" 且 approved=true 提交，否则不予存储。',
  };
  if (excerpt.trim().length > 0) {
    if (includeSensitive) {
      draft.sensitive = { excerpt, note: '敏感附件：用户显式命令提供（includeSensitive=true），用于调试，请勿外传' };
    } else {
      draft.reviewGate += '（检测到 sensitiveExcerpt，但未开启 includeSensitive，已按默认脱敏策略忽略该片段）';
    }
  }
  return draft;
}

/**
 * approve 阶段：审阅门。approved !== true 一律拒绝（不储存）；
 * 对审阅后的 draft 再脱敏一次兜底（防审阅编辑引入敏感形态），随后产出可入库文档。
 */
export function buildAcceptedDocument(
  input: { draft?: unknown; approved?: unknown; reviewComment?: unknown },
  opts: { now: string },
): AcceptedFeedback | FeedbackError {
  if (input.approved !== true && input.approved !== 'true') {
    return { error: '审阅未通过：approved 必须为 true 才存储反馈文档；未通过的草稿一律不储存' };
  }
  const d = input.draft;
  if (typeof d !== 'object' || d === null) {
    return { error: 'draft 必填：prepare 返回并经用户审阅的 draft 对象（原样或修订版）' };
  }
  const draft = d as Partial<FeedbackDraft>;
  if (!isNonEmptyString(draft.docId)) return { error: 'draft.docId 缺失：须为 prepare 返回的草稿对象' };
  if (!FEEDBACK_KINDS.includes(draft.kind as FeedbackKind)) {
    return { error: `draft.kind 非法：${String(draft.kind)}；可选：${FEEDBACK_KINDS.join(' | ')}` };
  }
  if (!isNonEmptyString(draft.summary)) return { error: 'draft.summary 缺失或为空白' };

  const redactions: Redaction[] = [];
  const collect = (r: { text: string; redactions: Redaction[] }) => {
    for (const red of r.redactions) {
      const existing = redactions.find((x) => x.type === red.type);
      if (existing) existing.count += red.count;
      else redactions.push({ ...red });
    }
    return r.text;
  };
  const doc: AcceptedFeedback = {
    schema: 1,
    docId: draft.docId,
    acceptedAt: opts.now,
    kind: draft.kind as FeedbackKind,
    kindLabel: KIND_LABELS[draft.kind as FeedbackKind],
    summary: collect(sanitizeText(String(draft.summary))),
    detail: collect(sanitizeText(toOptString(draft.detail))),
    context: collect(sanitizeText(toOptString(draft.context))),
    redactions,
    source: 'submit_feedback',
  };
  if (draft.sensitive && typeof draft.sensitive === 'object' && isNonEmptyString((draft.sensitive as { excerpt?: unknown }).excerpt)) {
    doc.sensitive = {
      excerpt: String((draft.sensitive as { excerpt: unknown }).excerpt),
      note: '敏感附件：用户显式命令提供（includeSensitive=true），用于调试，请勿外传',
    };
  }
  const reviewComment = toOptString(input.reviewComment).trim();
  if (reviewComment.length > 0) doc.reviewComment = reviewComment;
  return doc;
}
