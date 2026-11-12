/**
 * 教学数据集探查（inspect_teaching_dataset）核心：纯函数，零 IO。
 * 入参校验、响应归一化（对官方演进做防御性解析）、教学相关性启发式评分。
 * 网络访问由适配层 adapters/odlab/datasets.ts 完成（OpenDataLab 官方 OpenAPI）。
 *
 * 降级哲学（与平台不可用解耦）：
 *  - 公共仓库匿名即可探查（官方 SDK 行为：list 无需授权）——无 AK/SK 也能用；
 *  - 受限仓库 401 → 执行器返回 degraded + 配置引导，探查结果为空不中断工作流。
 */

/** 归一化后的数据集文件项 */
export interface DatasetFileItem {
  path: string;
  size: number;
  /** 目录项（path 以 / 结尾或无 size 时为 true） */
  isDir: boolean;
}

/** 归一化后的数据集仓库信息 */
export interface DatasetSummary {
  repo: string;
  name: string;
  owner: string;
  description: string;
  visibility: 'public' | 'restricted' | 'unknown';
  tags: string[];
  fileCount: number;
  totalBytes: number;
  files: DatasetFileItem[];
  /** 教学相关性启发式（按文件名/路径关键词，确定性） */
  teachingRelevance: 'high' | 'medium' | 'low';
  matchedKeywords: string[];
  /** 分页游标：非空表示还有下一页（listFiles 截断时透传） */
  nextCursor?: string;
  truncated: boolean;
  source: 'opendatalab';
}

export interface InspectDatasetInput {
  repo?: unknown;
  listFiles?: unknown;
  maxFiles?: unknown;
  prefix?: unknown;
}

export type InspectPlan =
  | { ok: true; repo: string; listFiles: boolean; maxFiles: number; prefix?: string }
  | { ok: false; error: string };

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_FILES_CAP = 1000;

/** 教学相关性关键词（文件名/路径命中即给分，确定性排序） */
const TEACHING_KEYWORDS = [
  // 高权重：试题/教材/课件
  'exam', '试题', '试卷', '考题', '题库', 'question-bank', 'question_bank',
  'textbook', '教材', '教科书', '课本',
  'lecture', '讲义', '课件', '教案', '教学',
  // 中权重：课程/学习相关
  'course', 'curriculum', 'lesson', 'mooc', '慕课',
  'student', '学习者', '课堂', '作业', 'homework',
  'knowledge', '知识点', '教育', 'education',
] as const;

export function planInspectDataset(input: InspectDatasetInput): InspectPlan {
  if (typeof input.repo !== 'string' || !input.repo.trim()) {
    return { ok: false, error: 'repo 必填：数据集仓库地址 "username/repo_name"（如 OpenDataLab/UniTE）' };
  }
  const repo = input.repo.trim();
  if (!REPO.test(repo)) {
    return { ok: false, error: `repo 形态非法："${repo}"（须为 username/repo_name，字母数字._-）` };
  }
  const listFiles = input.listFiles === undefined ? true : input.listFiles === true;
  const maxFilesRaw = input.maxFiles === undefined ? 200 : Number(input.maxFiles);
  if (!Number.isInteger(maxFilesRaw) || maxFilesRaw < 1 || maxFilesRaw > MAX_FILES_CAP) {
    return { ok: false, error: `maxFiles 须为 1-${MAX_FILES_CAP} 整数：${String(input.maxFiles)}` };
  }
  let prefix: string | undefined;
  if (input.prefix !== undefined) {
    if (typeof input.prefix !== 'string' || input.prefix.includes('..')) {
      return { ok: false, error: 'prefix 须为目录字符串且不含 ".."' };
    }
    prefix = input.prefix.replace(/^\/+|\/+$/g, '');
  }
  return { ok: true, repo, listFiles, maxFiles: maxFilesRaw, ...(prefix ? { prefix } : {}) };
}

/** 官方 URL 路径段用逗号替代斜杠（openxlab SDK：dataset_repo.replace('/', ',')） */
export function repoToApiName(repo: string): string {
  return repo.replace(/\//g, ',');
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** 教学相关性评分（确定性：命中高权重词→high，其余命中→medium，无命中→low） */
export function scoreTeachingRelevance(paths: string[]): { level: 'high' | 'medium' | 'low'; matched: string[] } {
  const highWords = new Set<string>(TEACHING_KEYWORDS.slice(0, 18));
  const joined = paths.join('\n').toLowerCase();
  const matched = new Set<string>();
  let hasHigh = false;
  for (const kw of TEACHING_KEYWORDS) {
    if (joined.includes(kw.toLowerCase())) {
      matched.add(kw);
      if (highWords.has(kw)) hasHigh = true;
    }
  }
  return {
    level: matched.size === 0 ? 'low' : hasHigh ? 'high' : 'medium',
    matched: [...matched],
  };
}

/** 归一化文件列表（防御官方字段演进：path/name、size 缺省按 0/目录处理） */
export function normalizeFiles(raw: unknown): DatasetFileItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DatasetFileItem[] = [];
  for (const f of raw) {
    if (!isObj(f)) continue;
    const p = typeof f.path === 'string' ? f.path : typeof f.name === 'string' ? f.name : '';
    if (!p) continue;
    const size = typeof f.size === 'number' && Number.isFinite(f.size) ? f.size : 0;
    const isDir = typeof f.type === 'string' ? f.type === 'dir' : p.endsWith('/');
    out.push({ path: p, size, isDir });
  }
  return out;
}

/** 归一化 info 响应（字段缺失给安全缺省；显示名优先响应对，回退 repo 段） */
export function normalizeInfo(repo: string, raw: unknown): Omit<DatasetSummary, 'files' | 'nextCursor' | 'truncated' | 'teachingRelevance' | 'matchedKeywords'> {
  const r = isObj(raw) ? raw : {};
  const [owner, repoName] = repo.split('/');
  const pickStr = (...cands: unknown[]): string => {
    for (const c of cands) if (typeof c === 'string' && c) return c;
    return '';
  };
  const visibilityRaw = pickStr(r.visibility, r.permission).toLowerCase();
  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [];
  return {
    repo,
    name: pickStr(r.name, r.displayName, r.datasetName) || repoName,
    owner: pickStr(r.owner, r.username, r.namespace) || owner,
    description: pickStr(r.description, r.desc, r.introduction),
    visibility: visibilityRaw.includes('public') ? 'public' : visibilityRaw ? 'restricted' : 'unknown',
    tags,
    fileCount: typeof r.fileCount === 'number' ? r.fileCount : typeof r.file_count === 'number' ? r.file_count : 0,
    totalBytes: typeof r.totalBytes === 'number' ? r.totalBytes : typeof r.total_size === 'number' ? r.total_size : 0,
    source: 'opendatalab',
  };
}
