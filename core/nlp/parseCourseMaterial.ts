/**
 * 课程材料解析（parse_course_material）——M1 首个切片。
 *
 * 纯 TS 实现，不依赖 Node API：文件读取/二进制解码由适配层完成，
 * 本模块只接收纯文本内容 + 材料类型标识。
 *
 * 两条路径：
 *  - 启发式默认实现（无 LLM）：章节识别、段落切分、知识点候选抽取；
 *  - LLM 增强路径：宿主通过 SkillContext.llm 注入 provider 后，
 *    对知识点候选做精炼/归并。
 *
 * 降级行为对齐契约：不支持的格式/无法结构化的输入退化为纯文本直通，
 * 降级等级标注为 degraded。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';

export const PARSE_COURSE_MATERIAL_ID = 'parse_course_material';

/** 输入：对齐契约中的 materialFile / materialType。
 *  适配层负责把文件路径或二进制内容解码为纯文本后传入 content。 */
export interface ParseCourseMaterialInput {
  /** 材料纯文本内容 */
  content: string;
  /** 材料类型标识，如 md、txt、srt、vtt、pptx、pdf */
  materialType: string;
  options?: {
    extraStoplist?: string[];
    /** LLM 术语度过滤：'auto'（默认，有 ctx.llm 即启用）| 'off'（完全走启发式） */
    llmFilter?: 'auto' | 'off';
    /** 文本规范化（R3-6，反馈 b P2-1）：中文标点/全角空格清洗；默认 false，缺省行为不变 */
    normalize?: boolean;
    /** 材料语种标识（默认 'zh'；当前透传标注于输出，过滤规则后续按语种扩展） */
    language?: string;
    /** 领域术语表：表内术语强制进入候选池（在文中出现即保留，跳过停用过滤） */
    glossary?: string[];
    /** 来源标注（内部）：适配层在 OCR/分页解码路径注入（如 "ocr"），段落/表格带 source 字段 */
    annotateSource?: string;
  };
}

export interface ParsedSection {
  title: string;
  level: number;
  order: number;
}

export interface ParsedParagraph {
  index: number;
  text: string;
  /** 所属章节序号（无章节时为 -1） */
  sectionOrder: number;
  /** 来源页码（OCR/分页解码的页锚点；无分页信息时不带） */
  page?: number;
  /** 来源标注（如 "ocr"；不带则为常规解析） */
  source?: string;
}

/** 结构化表格（反馈 b P1-1：表格不再压成一个 paragraph；表头为键、行为记录） */
export interface ParsedTable {
  /** 表头单元格（第一行） */
  header: string[];
  /** 数据行（不含表头与 Markdown 分隔行） */
  rows: string[][];
  /** 所属章节序号（按标题行定位；-1=无法归属，如无标题文本的 docx） */
  sectionOrder: number;
  /** 来源页码（OCR/分页解码的页锚点；无分页信息时不带） */
  page?: number;
  /** 来源标注（如 "ocr"；不带则为常规解析） */
  source?: string;
}

/** OCR/解码 meta（R5-1：扫描件结构化摄取信息；R6-2：textLayer=原生文本层直出） */
export interface ParseOcrMeta {
  engine: string;
  language: string;
  pages: number;
  elapsedMs: number;
  /** 自动探测触发（未显式传 ocr:true） */
  auto: boolean;
  /** 原生 PDF 文本层抽取（非 OCR；完全跳过 OCR 路径） */
  textLayer?: boolean;
}

/** LLM 术语度过滤报告（随输出附带；未启用时 enabled=false） */
export interface LlmFilterReport {
  enabled: boolean;
  degraded: boolean;
  kept: number;
  dropped: number;
  distribution: { term: number; operation: number; phrase: number; noise: number };
  droppedSamples: string[];
  elapsedMs?: number;
  estimatedMs?: number;
  batches?: number;
  longRunning?: boolean;
  budgetExhausted?: boolean;
  unprocessedBatches?: number;
}

const EMPTY_TIMING = {
  elapsedMs: 0,
  estimatedMs: 0,
  batches: 0,
  longRunning: false,
  budgetExhausted: false,
  unprocessedBatches: 0,
};

export interface ParseCourseMaterialOutput {
  structuredSections: ParsedSection[];
  paragraphs: ParsedParagraph[];
  /** 结构化表格（Markdown 管道表格与 docx 表格行；无表格时为空数组） */
  tables: ParsedTable[];
  knowledgePointCandidates: KnowledgePointCandidate[];
  /** LLM 术语度过滤报告（未启用时 enabled=false，见 LlmFilterReport） */
  llmFilterReport: LlmFilterReport;
  /** 材料语种标识回声（options.language 提供时） */
  language?: string;
  /** 解码 meta（OCR 路径时给出） */
  meta?: { ocr?: ParseOcrMeta };
}

export interface KnowledgePointCandidate {
  term: string;
  /** 出现次数（启发式打分依据） */
  score: number;
  /** 来源位置：命中的段落序号列表 */
  occurrences: number[];
}


/** 已知可解析的文本类格式（二进制解码由适配层在上游完成） */
const KNOWN_TYPES = new Set([
  'md',
  'markdown',
  'txt',
  'text',
  'srt',
  'vtt',
  'ppt',
  'pptx',
  'pdf',
  'doc',
  'docx',
]);

/** 基础中英文停用词（启发式词频过滤用） */
export const GENERIC_STOPWORDS = new Set([
  // 中文
  '我们', '你们', '他们', '的', '了', '是', '在', '和', '与', '及', '或', '这', '那',
  '这个', '那个', '一个', '可以', '通过', '进行', '相关', '以及', '对于', '其中',
  '作为', '需要', '能够', '时候', '因为', '所以', '如果', '就是', '不是', '没有',
  '一步', '每一', '一种', '一次', '一样', '意味着', '有助于',
  '如何', '什么', '怎么', '大家', '同学', '老师', '本文', '本章', '本节', '下面',
  '上面', '例如', '比如', '首先', '其次', '最后', '然后', '因此', '但是', '而且',
  '并且', '这种', '这些', '那些', '已经', '正在', '将会', '比较', '非常', '可能',
  '应该', '主要', '包括', '如下', '内容', '课程', '学习', '教学', '实验', '概念',
  '反复', '出现', '现象', '基础', '常用', '效果',
  '过滤', '分离', '加入', '计算', '准确', '避免', '处理', '设计', '称为', '属于',
  // 英文
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'were', 'will',
  'can', 'you', 'your', 'our', 'their', 'have', 'has', 'been', 'into', 'about',
  'when', 'then', 'than', 'such', 'these', 'those',
]);

/** 知识点候选上限 */
const MAX_CANDIDATES = 20;

type HeadingMatch = { title: string; level: number } | null;

/** 章节识别：Markdown 标题 */
function matchMarkdownHeading(line: string): HeadingMatch {
  const m = /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
  return m ? { title: m[2], level: m[1].length } : null;
}

/** 章节识别：中文编号模式（"第一章 ……" / "一、……"） */
function matchChineseHeading(line: string): HeadingMatch {
  if (line.length > 60) return null;
  if (/^第[0-9一二三四五六七八九十百千]+[章节讲课部分篇]\s*[：:、.．]?\s*\S/.test(line)) {
    return { title: line.trim(), level: 1 };
  }
  if (/^[一二三四五六七八九十]+、\s*\S/.test(line)) {
    return { title: line.trim(), level: 2 };
  }
  return null;
}

/** 章节识别：数字编号模式，层级=点数+1。
 *  样式 A："1. 标题" / "1、标题" / "1.1. 标题"（编号以 . 或 、 收尾）；
 *  样式 B："1.1 标题"（含层级点的编号 + 空白分隔，无收尾点号）。
 *  无点号的裸数字（如"3 个特征"）不构成标题，避免误识别正文。 */
function matchNumericHeading(line: string, inExerciseBlock = false): HeadingMatch {
  const t = line.trim();
  if (t.length > 25) return null;
  if (/^[\d.]+$/.test(t)) return null; // 纯数字/小数行（16.8、2.0、6.34.9）不成标题
  if (/[。！？!?？]$/.test(t)) return null; // 句号/问号收尾 = 习题句，不成标题
  if (inExerciseBlock) return null; // 习题块/编号列表块内的编号行按正文处理
  let m = /^(\d+\.\d+(?:\.\d+)*)\s+(\S.*)$/.exec(t); // 样式 B 优先："1.1 标题"
  if (!m) m = /^(\d+)\s*[.、]\s*(\S.*)$/.exec(t); // 样式 A："1. 标题"（编号不吃点号后缀）
  if (!m) return null;
  if (/^[\d.]+$/.test(m[2])) return null;
  const dots = (m[1].match(/\./g) ?? []).length;
  return { title: t, level: 1 + dots };
}

function matchHeading(line: string, inExerciseBlock = false): HeadingMatch {
  return (
    matchMarkdownHeading(line) ??
    matchChineseHeading(line) ??
    matchNumericHeading(line, inExerciseBlock)
  );
}

function isListItem(line: string): boolean {
  return /^[-*•]\s+/.test(line) || /^\d+[.)、]\s+/.test(line);
}

/** 字幕预处理：去掉序号行与时间轴行 */
function stripSubtitleArtifacts(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (t === '') return true;
      if (/^\d+$/.test(t)) return false;
      if (/^\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(t)) return false;
      if (/^WEBVTT/.test(t)) return false;
      return true;
    })
    .join('\n');
}

/** 单遍构建章节与段落：空行分段；连续列表项并入同一段落 */
// ---------- 结构化表格提取（反馈 b P1-1：表格保真，表头为键、行为记录） ----------

/** 拆表格行为单元格（兼容 Markdown 首尾管道与 docx 的 "a | b" 形态） */
function splitTableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/** Markdown 分隔行（|---|---| 或 |:--|--:|） */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 &&
    cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));
}

/** 表格行判定：含管道且能拆出 ≥2 个非空单元格 */
function looksLikeTableLine(line: string): boolean {
  if (!line.includes('|')) return false;
  return splitTableCells(line).filter((c) => c !== '').length >= 2;
}

interface RawTableBlock {
  /** 在原始行数组中的区间 [start, end) */
  start: number;
  end: number;
  /** 有效行（已剔除分隔行与全空行）；首行即表头 */
  rows: string[][];
}

/**
 * 从文本行中提取连续表格块（Markdown 管道表格 / docx 抽取的 " | " 行）。
 * 单行行块不算表格（放行回原段落，避免误吞含管道符的散文）。
 */
export function extractTableBlocks(lines: string[]): RawTableBlock[] {
  const blocks: RawTableBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!looksLikeTableLine(lines[i])) { i += 1; continue; }
    let j = i;
    const rawRows: string[][] = [];
    // 管道起始一致性：md 表格整行以 | 起止；docx "a | b" 行则全非管道起始——
    // 混合即断块，避免散文中的 "a | b" 被吞进表格（反馈 b P1-1 边界）
    const pipeStart = lines[i].trim().startsWith('|');
    while (j < lines.length && looksLikeTableLine(lines[j]) &&
           lines[j].trim().startsWith('|') === pipeStart) {
      rawRows.push(splitTableCells(lines[j]));
      j += 1;
    }
    const rows = rawRows
      .filter((cells) => !isSeparatorRow(cells))
      .filter((cells) => cells.some((c) => c !== ''));
    if (rows.length >= 2) blocks.push({ start: i, end: j, rows });
    i = j;
  }
  return blocks;
}

/** 逐行定位当前章节序号：按 sections 标题在文本中的出现顺序推进（标题行/正文提及均可） */
function lineSectionOrders(lines: string[], sections: ParsedSection[]): number[] {
  const out: number[] = [];
  let expected = 0;
  let current = -1;
  for (const line of lines) {
    if (expected < sections.length && sections[expected].title &&
        line.includes(sections[expected].title)) {
      current = expected;
      expected += 1;
    }
    out.push(current);
  }
  return out;
}

/** 表格单元格并入知识点候选（新词追加，score=1 低权；已存在术语不重复） */
function mergeTableCellCandidates(
  candidates: KnowledgePointCandidate[],
  tables: ParsedTable[],
): KnowledgePointCandidate[] {
  const seen = new Set(candidates.map((c) => c.term));
  const out = [...candidates];
  for (const t of tables) {
    for (const cell of [...t.header, ...t.rows.flat()]) {
      const term = cell.trim();
      if (term.length < 4 || term.length > 30 || seen.has(term)) continue;
      seen.add(term);
      out.push({ term, score: 1, occurrences: [] });
    }
  }
  return out;
}

/** 领域术语表强制入池（R3-6）：术语在文中出现即保留（跳过停用过滤），score=命中段数 */
function mergeGlossaryCandidates(
  candidates: KnowledgePointCandidate[],
  glossary: string[],
  paragraphs: ParsedParagraph[],
): KnowledgePointCandidate[] {
  const seen = new Set(candidates.map((c) => c.term));
  const out = [...candidates];
  for (const raw of glossary) {
    const term = raw.trim();
    if (!term || seen.has(term)) continue;
    const occurrences: number[] = [];
    paragraphs.forEach((p, k) => {
      if (p.text.includes(term)) occurrences.push(p.index ?? k);
    });
    if (occurrences.length === 0) continue;
    seen.add(term);
    out.push({ term, score: occurrences.length, occurrences });
  }
  return out;
}

/** 文本规范化（R3-6，反馈 b P2-1）：全角空格/零宽字符清理、弯引号拉直、全角括号转半角、空白折叠 */
export function normalizeCourseText(text: string): string {
  return text
    .replace(/[　​‌‍﻿]/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function buildSectionsAndParagraphs(
  rawLines: string[],
  pages?: number[],
  annotateSource?: string,
): { sections: ParsedSection[]; paragraphs: ParsedParagraph[] } {
  // 教材模式预处理：页眉页脚过滤 + 习题块预标记
  const lines = stripHeaderFooters(rawLines);
  const exerciseBlocks = findExerciseBlockLines(lines);
  const sections: ParsedSection[] = [];
  const paragraphs: ParsedParagraph[] = [];
  let buf: string[] = [];
  let bufSection = -1;
  let bufPage = -1;
  let currentSection = -1;

  // 段落行合并：连续普通行视为换行折行并为一个段落（折行处中英边界补空格），
  // 列表项与正文之间、列表项组之间保持分段
  const joinBuf = (): string => {
    if (buf.length === 0) return '';
    const listRun = isListItem(buf[0]);
    let out = buf[0];
    for (let i = 1; i < buf.length; i++) {
      const sep = listRun ? '\n'
        : /[一-鿿]$/.test(out) || /^[一-鿿]/.test(buf[i]) ? '' : ' ';
      out += sep + buf[i];
    }
    return out.trim();
  };

  const flush = () => {
    const text = joinBuf();
    if (text) {
      paragraphs.push({
        index: paragraphs.length,
        text,
        sectionOrder: bufSection,
        ...(bufPage >= 0 ? { page: bufPage } : {}),
        ...(annotateSource ? { source: annotateSource } : {}),
      });
    }
    buf = [];
    bufSection = -1;
    bufPage = -1;
  };

  for (const [idx, line] of lines.entries()) {
    const heading = matchHeading(line, exerciseBlocks.has(idx));
    if (heading) {
      flush();
      currentSection = sections.length;
      sections.push({ ...heading, order: currentSection });
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '') {
      flush();
      continue;
    }
    const runIsList = buf.length > 0 && isListItem(buf[0]);
    if (buf.length > 0 && isListItem(trimmed) !== runIsList) flush();
    if (buf.length === 0) {
      bufSection = currentSection;
      bufPage = pages?.[idx] ?? -1;
    }
    buf.push(trimmed);
  }
  flush();

  // 重复页眉守卫：同一标题文本出现 ≥3 次，且在标题次序中相邻出现
  // （课件页眉式重复，如每页顶部"2. 实验原理"）→ 整体降级为正文；
  // 讲义类"每个实验一章、章内固定小节"的结构（次序间有其他标题）不受影响
  const seenTitles = new Map<string, number[]>();
  sections.forEach((s, order) => {
    seenTitles.set(s.title, [...(seenTitles.get(s.title) ?? []), order]);
  });
  const demote = new Map<number, string>();
  for (const [title, orders] of seenTitles) {
    if (orders.length < 3) continue;
    let adjacent = true;
    for (let i = 1; i < orders.length; i++) {
      if (orders[i] - orders[i - 1] !== 1) { adjacent = false; break; }
    }
    if (adjacent) orders.forEach((o) => demote.set(o, title));
  }
  if (demote.size > 0) {
    // 重建：被降级标题按正文行插回段落流（挂到当前章节）
    return buildWithDemotes(lines, exerciseBlocks, demote);
  }

  return { sections, paragraphs };
}

/** 带降级标题的重建：被降级标题按正文行处理（挂到当前章节） */
function buildWithDemotes(
  lines: string[],
  exerciseBlocks: Set<number>,
  demotes: Map<number, string>,
): { sections: ParsedSection[]; paragraphs: ParsedParagraph[] } {
  const sections: ParsedSection[] = [];
  const paragraphs: ParsedParagraph[] = [];
  let buf: string[] = [];
  let bufSection = -1;
  let bufPage = -1;
  let currentSection = -1;
  let headingOrdinal = -1;

  const joinBuf = (): string => {
    if (buf.length === 0) return '';
    const listRun = isListItem(buf[0]);
    let out = buf[0];
    for (let i = 1; i < buf.length; i++) {
      const sep = listRun ? '\n'
        : /[一-鿿]$/.test(out) || /^[一-鿿]/.test(buf[i]) ? '' : ' ';
      out += sep + buf[i];
    }
    return out.trim();
  };
  const flush = () => {
    const text = joinBuf();
    if (text) paragraphs.push({ index: paragraphs.length, text, sectionOrder: bufSection });
    buf = [];
    bufSection = -1;
  };

  for (const [idx, line] of lines.entries()) {
    const match = matchHeading(line, exerciseBlocks.has(idx));
    if (match) {
      headingOrdinal += 1;
      if (demotes.has(headingOrdinal)) {
        // 降级：作为正文行
        if (buf.length > 0 && (isListItem(line.trim()) || isListItem(buf[buf.length - 1]))) flush();
        if (buf.length === 0) bufSection = currentSection;
        buf.push(line.trim());
        continue;
      }
      flush();
      currentSection = sections.length;
      sections.push({ ...match, order: currentSection });
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '') { flush(); continue; }
    const runIsList = buf.length > 0 && isListItem(buf[0]);
    if (buf.length > 0 && isListItem(trimmed) !== runIsList) flush();
    if (buf.length === 0) bufSection = currentSection;
    buf.push(trimmed);
  }
  flush();
  return { sections, paragraphs };
}

/** 候选词抽取：中文 n-gram（2–6 字，统计词频）与英文单词（≥3 字母）。
 *  n-gram 方案避免整句粘连，使"梯度下降""损失函数"等术语可被单独命中。 */
const NGRAM_MIN = 2;
const NGRAM_MAX = 8;

/** n-gram 首尾虚词过滤（避免出现"的学习"之类的噪声候选） */
const NGRAM_EDGE_STOP = new Set([
  '的', '了', '是', '在', '和', '与', '或', '及', '把', '并', '但', '就', '都', '也', '而', '当',
]);

function extractCandidates(
  paragraphs: ParsedParagraph[],
  opts: { extraStoplist?: string[] } = {},
): KnowledgePointCandidate[] {
  const extraStop = new Set((opts.extraStoplist ?? []).map((w) => w.toLowerCase()));
  // 课件模板停用表（双向匹配 + ≥3 字子串包含）：套话短语整串及其子串不进候选
const TEMPLATE_STOPWORDS = [
  '实验目的', '实验原理', '实验步骤', '实验材料', '实验方法', '实验结果', '实验概念',
  '注意事项', '思考题', '小结', '总结', '目录', '本节内容', '本章内容', '教学目标',
  '在课程中反复出现', '课程中反复出现', '反复出现', '按下表操作', '基于实验现象进行',
  '进行了细致的讨论', '细致的讨论', '学生分组汇报结果', '如表所示', '如下图所示',
];
const templateRejects = (g: string): boolean => {
  if (g.length < 3) return false;
  return TEMPLATE_STOPWORDS.some((p) => p.includes(g));
};
const FUNC_CHARS = new Set(['了', '把', '被', '将', '是', '在']);
const OP_PREFIX = new Set(['用', '将', '把', '被', '使', '当', '按', '若', '从']);
const LOC_SUFFIX = ['时', '后', '前', '内', '中', '上', '下', '里', '处', '进行'];
const rejectGram = (g: string): boolean => {
  if (templateRejects(g)) return true;
  for (const ch of g) if (FUNC_CHARS.has(ch)) return true;
  if (OP_PREFIX.has(g[0])) return true;
  if (LOC_SUFFIX.some((suf) => g.endsWith(suf))) return true;
  if (/^(.)\1$/.test(g)) return true; // 叠字 AA 型（生生/汪汪）
  return false;
};
const stats = new Map<string, { count: number; occurrences: Set<number> }>();
  const bump = (term: string, paraIdx: number) => {
    const entry = stats.get(term) ?? { count: 0, occurrences: new Set() };
    entry.count += 1;
    entry.occurrences.add(paraIdx);
    stats.set(term, entry);
  };
  for (const para of paragraphs) {
    for (const run of para.text.matchAll(/[一-鿿]+/g)) {
      const s = run[0];
      for (let n = NGRAM_MIN; n <= Math.min(NGRAM_MAX, s.length); n++) {
        for (let i = 0; i + n <= s.length; i++) {
          const g = s.slice(i, i + n);
          if (GENERIC_STOPWORDS.has(g) || extraStop.has(g.toLowerCase()) || rejectGram(g)) continue;
          if (NGRAM_EDGE_STOP.has(g[0]) || NGRAM_EDGE_STOP.has(g[g.length - 1])) continue;
          bump(g, para.index);
        }
      }
    }
    for (const m of para.text.matchAll(/[A-Za-z][A-Za-z-]{2,}/g)) {
      if (!GENERIC_STOPWORDS.has(m[0]) && !extraStop.has(m[0].toLowerCase()) && !rejectGram(m[0])) bump(m[0], para.index);
    }
  }
  // 保留：出现次数 ≥3 或覆盖 ≥2 个段落；两阶段方向去重——
  // 先收 4 字及以上术语（如"梯度下降""损失函数"），再收 2–3 字短词，
  // 但短词被已收长词完整包含时跳过（避免"梯度/损失"肢解长术语，
  // 同时"监督学习"与"无监督学习"因方向不同得以并存）
  const filtered = [...stats.entries()].filter(
    ([, s]) => s.count >= 2 || s.occurrences.size >= 2,
  );
  const sorted = filtered.sort(
    (a, b) => b[1].count - a[1].count || b[0].length - a[0].length || a[0].localeCompare(b[0], 'zh'),
  );
  const accepted: Array<[string, { count: number; occurrences: Set<number> }]> = [];
  for (const item of sorted.filter(([t]) => t.length >= 4)) {
    if (accepted.some(([t]) => t.includes(item[0]))) continue;
    accepted.push(item);
  }
  for (const item of sorted.filter(([t]) => t.length < 4)) {
    if (accepted.some(([t, sT]) => t.includes(item[0]) && sT.count >= item[1].count * 0.5)) continue; // 短词仅被词频相当(≥50%)的长词吸收
    accepted.push(item);
  }
  // OCR 碎片丢弃（教材模式）——前缀碎片规则：
  //  t 是更长已收术语 T 的前缀（|T|≥|t|+2）且 T 词频 ≥ 30%·t → t 判定为碎片并清除
  //  （"生物的生"被"生物的生长发育"清除；"随机梯度下降"这类无虚词复合扩展不受影响）。
  //  说明：后缀位置碎片（如"体与环境"）与真术语（如"耐受限度"）仅凭词频与扩展形态
  //  无法可靠区分，不在此处硬清，由下游 extract 的"出现段落子集"归并处理（教材实测有效）。
  // 高频头词救援：被吸收（子串于更长已收术语）但 distinct ≥5 且长度 ≥4 的术语召回
  // （吸收链中间节点，如"考马斯亮蓝"被"考马斯亮蓝法"吸收但自身高频）
  for (const item of sorted) {
    const [t, s] = item;
    if (t.length >= 4 && s.count >= 5 && !accepted.some(([a]) => a === t)) {
      if (!accepted.some(([a]) => a.includes(t)) || true) accepted.push(item);
    }
  }
  const survived = accepted.filter(([t, s]) => {
    const killer = accepted.find(([T, sT]) =>
      T !== t && T.length >= t.length + 2 &&
      T.startsWith(t) && sT.count >= s.count * 0.3,
    );
    return !killer;
  });
  return [...survived]
    .sort((a, b) => b[1].count - a[1].count || b[0].length - a[0].length || a[0].localeCompare(b[0], 'zh'))
    .map(([term, s]) => ({
      term,
      score: s.count,
      occurrences: [...s.occurrences].sort((a, b) => a - b),
    }));
  // 输出保留完整候选池（不再截断）——截断上限由 extract 建图时按需应用
}

/** 候选上限：基础 20；大文档按字数弹性扩展（每 4000 字 +1，封顶 60），
 *  避免整门课合并文本的真概念被通用流程词挤出前 20 */
function candidateCap(paragraphs: ParsedParagraph[]): number {
  const chars = paragraphs.reduce((n, p) => n + p.text.length, 0);
  return MAX_CANDIDATES + Math.min(40, Math.floor(chars / 4000));
}

/** LLM 增强：对候选知识点做精炼/归并；失败时回落启发式结果 */
/**
 * 术语度过滤提示词（导出供验收脚本复用，保证复测与线上同提示词）。
 * 四类分类：term（学科术语）/ operation（**规范操作技能名**——收紧定义：
 * 可在实验指导中作为独立技能教授的操作，如离心、滴定、点样、层析、恒温水浴；
 * 具体操作步骤描述如"盖紧缸盖""剧烈震荡""用毛细管吸样品"归 phrase）/
 * phrase（叙述短语/过程描述/套话）/ noise（OCR 错字/碎片）。
 */
/** 弹性候选上限：基础 20；大文档按字数扩展（每 4000 字 +1，封顶 60） */
export function elasticCandidateLimit(paragraphs: ParsedParagraph[]): number {
  const chars = paragraphs.reduce((n, p) => n + p.text.length, 0);
  return Math.min(60, 20 + Math.floor(chars / 4000));
}

/** 页眉页脚过滤：「短文本 + 页码」行出现 ≥3 次 → 全部剔除（教材扫描件常见噪声） */
export function stripHeaderFooters(lines: string[]): string[] {
  const keyOf = (l: string): string | null => {
    const t = l.trim();
    const m = /^(\S.{0,14}?\S)\s+\d{1,3}$/.exec(t);
    return m ? m[1] : null;
  };
  const freq = new Map<string, number>();
  for (const l of lines) {
    const k = keyOf(l);
    if (k) freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  const junk = new Set([...freq.entries()].filter(([, n]) => n >= 3).map(([k]) => k));
  if (junk.size === 0) return lines;
  return lines.filter((l) => {
    const k = keyOf(l);
    return k === null || !junk.has(k);
  });
}

/**
 * 习题块/编号列表块预标记：「习题/思考题/练习」标题之后至下一个标题前的行，
 * 或连续 ≥2 行的整数编号短行（1. xxx / 2. xxx）——块内数字编号行降级为正文。
 */
function findExerciseBlockLines(lines: string[]): Set<number> {
  const out = new Set<number>();
  const isNumItem = (t: string) => /^\d{1,2}\s*[.、]\s*\S/.test(t) && t.length <= 30;
  let inBlock = false;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (/^(习题|思考题|练习|作业|随堂练习)/.test(t) && t.length <= 12) {
      inBlock = true;
      return;
    }
    if (inBlock && matchHeading(t) && !/^(习题|思考题|练习|作业|随堂练习)/.test(t)) {
      inBlock = false;
      return;
    }
    if (inBlock) out.add(i);
  });
  // 编号列表块：连续 ≥2 行整数编号短行
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 2) run.forEach((i) => out.add(i));
    run = [];
  };
  lines.forEach((line, i) => {
    if (isNumItem(line.trim()) && !matchChineseHeading(line.trim())) run.push(i);
    else flush();
  });
  flush();
  return out;
}

export function buildTermFilterPrompt(terms: string[]): string {
  return [
    '你是生物化学实验课程的术语判定助手。请对以下每个候选词做四类分类（JSON 数组返回）：',
    '[{"term":"候选词","cls":"term|operation|phrase|noise","reason":"一句理由"}]',
    '分类标准：',
    '- term=学科术语/概念/物质/方法名/仪器设备名（如米氏常数、梯度洗脱、恒温水浴锅）；',
    '- operation=规范操作技能名：可在实验指导中作为独立技能教授的操作（如离心、滴定、点样、层析、恒温水浴、沸水浴、加酶）；',
    '  具体操作步骤或动作描述（盖紧缸盖、剧烈震荡、用毛细管吸样品、入层析缸）归 phrase，不得归 operation；',
    '- phrase=叙述短语/过程描述/课件套话（如"用纱布过滤""剧烈震荡后取出"）；',
    '- noise=OCR 错字/碎片/无意义串。',
    'few-shot 示例（严格照此边界执行）：',
    '[{"term":"剧烈震荡","cls":"phrase","reason":"操作方式的描述，非规范技能名"},',
    ' {"term":"恒温水浴","cls":"operation","reason":"规范操作技能"},',
    ' {"term":"恒温水浴锅","cls":"term","reason":"仪器设备名"},',
    ' {"term":"梯度洗脱","cls":"term","reason":"方法名，非操作动作"}]',
    '只输出 JSON 数组本身。',
    JSON.stringify(terms),
  ].join('\n');
}

const KEEP_CLASSES = new Set(['term', 'operation']);

/**
 * LLM 术语过滤启用阈值（契约锁定，反馈 c P1-1：小材料 enabled=false 致候选术语全灭）：
 * 行为保证——有 ctx.llm 且候选 ≥ 本阈值时明确启用；1–9 个候选同样尝试（天然单批轻量，
 * 不标 degraded）；仅 llmFilter:'off' 或无 LLM 注入才完全走启发式。
 */
export const LLM_FILTER_MIN_CANDIDATES = 10;

async function refineWithLlm(
  candidates: KnowledgePointCandidate[],
  ctx: SkillContext,
  llmFilter: 'auto' | 'off',
): Promise<{
  candidates: KnowledgePointCandidate[];
  report: LlmFilterReport;
  note: string;
}> {
  const emptyReport: LlmFilterReport = {
    enabled: false, degraded: false, kept: candidates.length, dropped: 0,
    distribution: { term: 0, operation: 0, phrase: 0, noise: 0 },
    droppedSamples: [],
    ...EMPTY_TIMING,
  };
  if (llmFilter === 'off' || !ctx.llm || candidates.length === 0) {
    return { candidates, report: emptyReport, note: '' };
  }

  const report: LlmFilterReport = {
    enabled: true, degraded: false, kept: 0, dropped: 0,
    distribution: { term: 0, operation: 0, phrase: 0, noise: 0 },
    droppedSamples: [],
    ...EMPTY_TIMING,
  };
  const notes: string[] = [];
  const decisions = new Map<string, 'keep' | 'drop'>();

  // 并发池执行（默认并发 4；总预算默认 12 分钟，耗尽后未完成批次保留启发式候选）
  const batchSize = 100;
  const batches: KnowledgePointCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize));
  }
  const total = batches.length;
  const concurrency = Math.max(1, Math.min(8, ctx.llmBatch?.concurrency ?? 4));
  const budgetMs = ctx.llmBatch?.budgetMs ?? 12 * 60_000;
  const onProgress = ctx.llmBatch?.onProgress;
  const t0 = Date.now();
  report.batches = total;

  const latencies: number[] = [];
  const batchDecisions = new Map<number, 'ok' | 'failed'>();
  let done = 0;
  let budgetExhausted = false;

  const estimateRemainingMs = () => {
    if (latencies.length === 0) return 0;
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    return Math.round(((total - done) * avg) / concurrency);
  };
  const notify = (prefix: string) => {
    const remainingMin = (estimateRemainingMs() / 60000).toFixed(1);
    onProgress?.(done, total, `${prefix} 第${done}/${total} 批，预计剩余约${remainingMin}分钟`);
  };

  // 预估前置：按批数与并发给出粗估，超 10 分钟先发声
  if (onProgress && total > 0) {
    onProgress(0, total, `LLM 术语过滤共 ${total} 批（并发 ${concurrency}）`);
  }

  let next = 0;
  const worker = async () => {
    for (;;) {
      if (budgetExhausted) return;
      const i = next;
      next += 1;
      if (i >= total) return;
      const batch = batches[i];
      const bt = Date.now();
      try {
        const raw = (await ctx.llm!.complete(buildTermFilterPrompt(batch.map((c) => c.term)), {
          temperature: 0.2,
        })).trim();
        const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
        const parsed: unknown = JSON.parse(cleaned);
        if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
        for (const item of parsed as Array<Record<string, unknown>>) {
          if (typeof item?.term !== 'string' || typeof item?.cls !== 'string') continue;
          const cls = item.cls;
          if (cls === 'term' || cls === 'operation' || cls === 'phrase' || cls === 'noise') {
            report.distribution[cls] += 1;
            decisions.set(item.term, KEEP_CLASSES.has(cls) ? 'keep' : 'drop');
          }
        }
        // 该批无有效决策的术语保留原候选（容错：LLM 漏判不丢词）
        for (const c of batch) {
          if (!decisions.has(c.term)) decisions.set(c.term, 'keep');
        }
        batchDecisions.set(i, 'ok');
      } catch (err) {
        // 该批非法：保留原候选，整体标 degraded；附错误摘要（complete 实现已脱敏）
        report.degraded = true;
        const detail = err instanceof Error ? err.message.slice(0, 120) : String(err);
        notes.push(`第 ${i + 1} 批分类失败，该批保留原候选：${detail}`);
        for (const c of batch) if (!decisions.has(c.term)) decisions.set(c.term, 'keep');
        batchDecisions.set(i, 'failed');
      }
      latencies.push(Date.now() - bt);
      done += 1;
      report.elapsedMs = Date.now() - t0;
      report.estimatedMs = report.elapsedMs + estimateRemainingMs();
      report.longRunning = (report.estimatedMs ?? 0) > 10 * 60_000;
      notify('LLM 术语过滤');
      if (Date.now() - t0 > budgetMs && done < total) budgetExhausted = true;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // 预算耗尽：未完成批次全部保留启发式候选（优雅部分降级，绝不全盘失败）
  if (budgetExhausted) {
    const unprocessed = total - done;
    report.budgetExhausted = true;
    report.unprocessedBatches = unprocessed;
    report.degraded = true;
    notes.push(ctx.llmBatch?.signal?.aborted
      ? `任务已取消：${unprocessed} 批未处理，已保留启发式候选`
      : `总预算 ${Math.round(budgetMs / 60000)} 分钟耗尽：${unprocessed} 批未处理，已保留启发式候选`);
    for (let i = 0; i < total; i++) {
      if (!batchDecisions.has(i)) {
        for (const c of batches[i]) if (!decisions.has(c.term)) decisions.set(c.term, 'keep');
      }
    }
  }
  report.elapsedMs = Date.now() - t0;
  // 估算收口：estimatedMs 是"当时已耗+剩余预估"，绝不能小于最终实际耗时
  // （最后一批完成到函数返回之间仍有归并耗时，负载下曾致 estimated<elapsed 抖动）
  report.estimatedMs = Math.max(report.estimatedMs ?? 0, report.elapsedMs);
  report.longRunning = (report.estimatedMs ?? 0) > 10 * 60_000;

  const kept: KnowledgePointCandidate[] = [];
  for (const c of candidates) {
    if ((decisions.get(c.term) ?? 'keep') === 'keep') kept.push(c);
  }
  report.kept = kept.length;
  report.dropped = candidates.length - kept.length;
  report.droppedSamples = candidates
    .filter((c) => decisions.get(c.term) === 'drop')
    .slice(0, 10)
    .map((c) => c.term);

  return { candidates: kept, report, note: notes.join('；') };
}

/** 主入口：解析课程材料文本 */
export async function parseCourseMaterial(
  input: ParseCourseMaterialInput,
  ctx: SkillContext = {},
): Promise<SkillResult<ParseCourseMaterialOutput>> {
  const materialType = input.materialType.trim().toLowerCase();

  // 降级路径：不支持的格式 → 纯文本直通（表格行仍结构化提取，行内其余按段落）
  if (!KNOWN_TYPES.has(materialType)) {
    const rawLines = input.content.split(/\r?\n/);
    const blocks = extractTableBlocks(rawLines);
    const tableLineSet = new Set<number>();
    for (const b of blocks) for (let k = b.start; k < b.end; k++) tableLineSet.add(k);
    const paragraphs: ParsedParagraph[] = rawLines
      .filter((_, idx) => !tableLineSet.has(idx))
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text, index) => ({ index, text, sectionOrder: -1 }));
    const tables: ParsedTable[] = blocks.map((b) => ({
      header: b.rows[0],
      rows: b.rows.slice(1),
      sectionOrder: -1, // 降级直通无章节结构
    }));
    return {
      skillId: PARSE_COURSE_MATERIAL_ID,
      level: 'degraded',
      data: {
        structuredSections: [],
        paragraphs,
        tables,
        knowledgePointCandidates: extractCandidates(paragraphs, input.options),
        llmFilterReport: {
          enabled: false, degraded: false, kept: 0, dropped: 0,
          distribution: { term: 0, operation: 0, phrase: 0, noise: 0 },
          droppedSamples: [],
          ...EMPTY_TIMING,
        },
      },
      degradationNote: `不支持的格式 "${input.materialType}"，已退化为纯文本提取`,
    };
  }

  let text = input.content;
  if (materialType === 'srt' || materialType === 'vtt') {
    text = stripSubtitleArtifacts(text);
  }
  // 文本规范化（R3-6）：中文标点/全角空格清洗（默认关闭，缺省行为不变）
  if (input.options?.normalize) {
    text = normalizeCourseText(text);
  }

  // 表格保真（反馈 b P1-1）：先提取表格块并剔除其行，不再把整张表压成一个 paragraph
  const rawLines = text.split(/\r?\n/);
  const blocks = extractTableBlocks(rawLines);
  const tableLineSet = new Set<number>();
  for (const b of blocks) for (let k = b.start; k < b.end; k++) tableLineSet.add(k);

  // 页锚点（R5-1）：`=== 第N页 ===` 分页标记——标记行剔除文本，段落/表格带 page；
  // 来源标注（options.annotateSource，适配层在 OCR 路径注入 "ocr"）
  const PAGE_MARKER = /^===\s*第(\d+)页\s*===$/;
  const contentLines: string[] = [];
  const contentPages: number[] = [];
  let currentPage = -1;
  rawLines.forEach((line, idx) => {
    const m = PAGE_MARKER.exec(line.trim());
    if (m) {
      currentPage = Number(m[1]);
      return; // 标记行不进正文
    }
    if (!tableLineSet.has(idx)) {
      contentLines.push(line);
      contentPages.push(currentPage);
    }
  });
  const filteredLines = contentLines;

  const annotateSource = input.options?.annotateSource;
  const { sections, paragraphs } = buildSectionsAndParagraphs(
    filteredLines,
    contentPages,
    annotateSource,
  );
  const secAtLine = lineSectionOrders(rawLines, sections);
  const pageAtRaw = (idx: number): number => {
    let pg = -1;
    for (let k = idx; k >= 0; k--) {
      const m = PAGE_MARKER.exec(rawLines[k].trim());
      if (m) { pg = Number(m[1]); break; }
    }
    return pg;
  };
  const tables: ParsedTable[] = blocks.map((b) => ({
    header: b.rows[0],
    rows: b.rows.slice(1),
    sectionOrder: secAtLine[b.start] ?? -1,
    ...(pageAtRaw(b.start) >= 0 ? { page: pageAtRaw(b.start) } : {}),
    ...(annotateSource ? { source: annotateSource } : {}),
  }));

  const candidates = extractCandidates(paragraphs, input.options);
  // 领域术语表强制入池（R3-6）：表内术语在文中出现即保留
  const withGlossary = input.options?.glossary?.length
    ? mergeGlossaryCandidates(candidates, input.options.glossary, paragraphs)
    : candidates;
  // 表格单元格文本并入知识点候选（去重、低权追加）
  const withTable = mergeTableCellCandidates(withGlossary, tables);
  const refined = await refineWithLlm(withTable, ctx, input.options?.llmFilter ?? 'auto');

  return {
    skillId: PARSE_COURSE_MATERIAL_ID,
    level: refined.note ? 'degraded' : 'full',
    data: {
      structuredSections: sections,
      paragraphs,
      tables,
      knowledgePointCandidates: refined.candidates,
      llmFilterReport: refined.report,
      ...(input.options?.language ? { language: input.options.language } : {}),
    },
    degradationNote: refined.note,
  };
}
