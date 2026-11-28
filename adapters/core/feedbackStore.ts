/**
 * 反馈存储（适配层，Node API）：仅接受审阅通过的 AcceptedFeedback 落盘。
 * 布局：<root>/accepted/<docId>.json + index.jsonl（loop engineering 的数据源）。
 * root 解析顺序：显式 rootDir 参数 > env NANGYING_FEEDBACK_DIR > configDir()/feedback
 * （旧默认 CWD 相对 .nangying-feedback 在宿主 cwd 不可控时落点漂移，已废弃；
 * 开发侧 loop 脚本 scripts/feedback-loop.mjs 仍默认读仓库根 .nangying-feedback）。
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configDir } from './configStore.js';
import type { AcceptedFeedback } from '../../core/feedback/feedback.js';

export function feedbackRoot(rootDir?: string): string {
  return resolve(rootDir ?? process.env.NANGYING_FEEDBACK_DIR ?? join(configDir(), 'feedback'));
}

export interface AcceptedIndexEntry {
  docId: string;
  acceptedAt: string;
  kind: string;
  summary: string;
  hasSensitive: boolean;
  reviewComment?: string;
  /** 维护者标记：已消化（转为 backlog/修复后置 true，loop 指标排除） */
  consumed?: boolean;
}

/** 入库：写全文 + 追加索引（单行 JSON，便于 loop 脚本流式读取） */
export function saveAcceptedFeedback(doc: AcceptedFeedback, rootDir?: string): { path: string; indexPath: string } {
  const root = feedbackRoot(rootDir);
  const dir = join(root, 'accepted');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${doc.docId}.json`);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  const indexPath = join(root, 'index.jsonl');
  const entry: AcceptedIndexEntry = {
    docId: doc.docId,
    acceptedAt: doc.acceptedAt,
    kind: doc.kind,
    summary: doc.summary,
    hasSensitive: Boolean(doc.sensitive),
    ...(doc.reviewComment ? { reviewComment: doc.reviewComment } : {}),
  };
  appendFileSync(indexPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return { path: file, indexPath };
}

/** 读取索引（跳过损坏行，坏行进 warnings） */
export function listAcceptedFeedback(rootDir?: string): { entries: AcceptedIndexEntry[]; warnings: string[] } {
  const indexPath = join(feedbackRoot(rootDir), 'index.jsonl');
  const entries: AcceptedIndexEntry[] = [];
  const warnings: string[] = [];
  if (!existsSync(indexPath)) return { entries, warnings };
  const lines = readFileSync(indexPath, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try {
      const e = JSON.parse(t) as AcceptedIndexEntry;
      if (e && typeof e.docId === 'string') entries.push(e);
      else warnings.push(`第 ${i + 1} 行：缺少 docId`);
    } catch {
      warnings.push(`第 ${i + 1} 行：JSON 解析失败`);
    }
  });
  return { entries, warnings };
}

/** 读取单篇已接受全文 */
export function loadAcceptedDocument(docId: string, rootDir?: string): AcceptedFeedback | null {
  const file = join(feedbackRoot(rootDir), 'accepted', `${docId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AcceptedFeedback;
  } catch {
    return null;
  }
}

/** 标记消化（loop 闭环：issue 转 backlog/修复后置 consumed，指标不再计入未消化） */
export function consumeFeedback(docId: string, rootDir?: string): boolean {
  const root = feedbackRoot(rootDir);
  const { entries } = listAcceptedFeedback(root);
  const idx = entries.findIndex((e) => e.docId === docId);
  if (idx < 0) return false;
  entries[idx] = { ...entries[idx], consumed: true };
  writeFileSync(
    join(root, 'index.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
  return true;
}

/** 列出已入库全文文档的文件名（诊断用） */
export function listAcceptedDocumentIds(rootDir?: string): string[] {
  const dir = join(feedbackRoot(rootDir), 'accepted');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}
