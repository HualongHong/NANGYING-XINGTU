/**
 * 摘要集解析（parse_abstract_collection）核心：纯函数，零 IO。
 * 会议摘要集 → 结构化记录（题名/作者/单位/关键词/正文/分会场/页码双坐标），
 * 含页号偏移 Δ 自动探测（方法论 3.4：不写死偏移量）、抽取缺陷旗标（3.8）与解析覆盖率（3.3）。
 * 分页文本由适配层/调用方提供（pdftotext 分页或 \f 分页的纯文本）；扫描件须先声明 OCR 降级。
 */

export interface AbstractRecord {
  id: string;
  title: string;
  authors: string[];
  affiliations: string[];
  keywords: string[];
  body: string;
  /** 分会场/栏目归属（未检出为 "未归属"） */
  session: string;
  /** PDF 物理页（1 起，区间） */
  physicalPages: [number, number];
  /** 印刷页 = 物理页 − Δ（偏移不可探测时为 undefined，来源标注须说明） */
  printedPage?: number;
  status: 'parsed' | 'incomplete';
  defects: string[];
}

export type PageOffsetResult =
  | { kind: 'constant'; delta: number }
  | { kind: 'segmented'; segments: { from: number; to: number; delta?: number; roman?: boolean }[] }
  | { kind: 'unavailable'; reason: string };

export interface ParsePlan {
  ok: boolean;
  pages: string[];
  entryPattern?: RegExp;
  sessionHints: string[];
  declaredTotal?: number;
  /** 调用方/LLM 预切分的记录（跳过自动切分，走归一化路径） */
  rawRecords?: unknown[];
  error?: string;
}

const DEFAULT_SESSION_HINTS = ['分会场', '专题', '专场', 'Session', 'session', '论坛', '报告会'] as const;
const DEFAULT_ENTRY_MIN_CHARS = 40;
const KEYWORDS_RE = /^(关键词|关\s*键\s*词|Key\s*words?|Keywords?)[:：]/i;
const AFFIL_RE = /(大学|学院|研究所|研究院|实验室|中心|University|Institute|College|Laboratory|Centre|Center|公司)/;
const POSTAL_RE = /\b\d{6}\b/;
/** 页脚/页眉的独立印刷页码行：不进正文（避免污染跨页断裂判定） */
const PAGE_MARKER_RE = /^[-—–]?\s*\d{1,4}\s*[-—–]?$/;
/** 题名超长阈值：超过则怀疑作者行被并入（方法论 6 F11：长题名吃作者行） */
const TITLE_LONG_CHARS = 60;

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** 入参校验：pages 优先，content 按 \f（pdftotext 分页符）切段；二者至少其一 */
export function planParseAbstractCollection(input: {
  pages?: unknown;
  content?: unknown;
  records?: unknown;
  entryPattern?: unknown;
  sessionHints?: unknown;
  declaredTotal?: unknown;
}): ParsePlan {
  let pages: string[] = [];
  if (Array.isArray(input.pages)) {
    pages = input.pages.filter((p): p is string => typeof p === 'string');
  } else if (typeof input.content === 'string') {
    pages = input.content.includes('\f') ? input.content.split('\f') : [input.content];
  }
  if (pages.length === 0) {
    return { ok: false, pages, sessionHints: [], error: 'pages（分页文本数组）与 content（纯文本，\f 分页）至少提供其一' };
  }
  let entryPattern: RegExp | undefined;
  if (input.entryPattern !== undefined) {
    if (typeof input.entryPattern !== 'string' || !input.entryPattern.trim()) {
      return { ok: false, pages, sessionHints: [], error: 'entryPattern 须为非空正则字符串（条目起始行特征，如 "^\\\\d{4}[一-龥]"）' };
    }
    try {
      entryPattern = new RegExp(input.entryPattern);
    } catch {
      return { ok: false, pages, sessionHints: [], error: `entryPattern 不是合法正则：${input.entryPattern}` };
    }
  }
  const sessionHints = Array.isArray(input.sessionHints)
    ? [...DEFAULT_SESSION_HINTS, ...input.sessionHints.filter((h): h is string => typeof h === 'string' && !!h.trim())]
    : [...DEFAULT_SESSION_HINTS];
  let declaredTotal: number | undefined;
  if (input.declaredTotal !== undefined) {
    const n = Number(input.declaredTotal);
    if (!Number.isInteger(n) || n < 1) return { ok: false, pages, sessionHints: [], error: 'declaredTotal 须为正整数（摘要集自述收录篇数）' };
    declaredTotal = n;
  }
  const rawRecords = Array.isArray(input.records) ? input.records : undefined;
  return { ok: true, pages, ...(entryPattern ? { entryPattern } : {}), sessionHints, ...(declaredTotal ? { declaredTotal } : {}), ...(rawRecords ? { rawRecords } : {}) };
}

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

function romanToInt(s: string): number | undefined {
  const t = s.trim().toLowerCase().replace(/[.．]\s*$/, '');
  if (!/^[ivxlcdm]+$/.test(t)) return undefined;
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const v = ROMAN[t[i]];
    const next = i + 1 < t.length ? ROMAN[t[i + 1]] : 0;
    total += v < next ? -v : v;
  }
  return total > 0 ? total : undefined;
}

/** 页内印刷页码候选：取首/末各 4 个非空行中「纯数字行」或「纯罗马数字行」，末行优先 */
export function extractPrintedCandidates(pageText: string): { arabic?: number; roman?: number } {
  const lines = pageText.split('\n').map((l) => l.trim()).filter(Boolean);
  const edge = [...lines.slice(0, 4), ...lines.slice(-4)];
  for (let i = edge.length - 1; i >= 0; i--) {
    const m = edge[i].match(/^[-—–]?\s*(\d{1,4})\s*[-—–]?$/);
    if (m) return { arabic: Number(m[1]) };
  }
  for (let i = edge.length - 1; i >= 0; i--) {
    const r = romanToInt(edge[i]);
    if (r !== undefined) return { roman: r };
  }
  return {};
}

/**
 * 页号偏移探测（方法论 3.4）：
 * 物理页 = 印刷页 + Δ。多组样本取一致 Δ；前言罗马页码与正文重启各成段；
 * 样本不足 3 组如实报 unavailable——调用方在来源标注里只给物理页。
 */
export function detectPageOffset(pages: string[]): PageOffsetResult {
  const arabicSamples: { p: number; a: number }[] = [];
  const romanPages: number[] = [];
  pages.forEach((text, idx) => {
    const c = extractPrintedCandidates(text);
    if (c.arabic !== undefined) arabicSamples.push({ p: idx + 1, a: c.arabic });
    else if (c.roman !== undefined) romanPages.push(idx + 1);
  });
  if (arabicSamples.length < 3) {
    return { kind: 'unavailable', reason: `可辨识印刷页码的样本不足 3 组（${arabicSamples.length} 组）：来源标注只给物理页` };
  }
  // 分段：印刷页号回落处切段（正文第 1 页重新计 1，或前言/正文两套体系）
  const segments: { from: number; to: number; delta?: number; roman?: boolean }[] = [];
  let start = 0;
  for (let i = 1; i < arabicSamples.length; i++) {
    if (arabicSamples[i].a < arabicSamples[i - 1].a) {
      segments.push({ from: arabicSamples[start].p, to: arabicSamples[i - 1].p, delta: arabicSamples[start].p - arabicSamples[start].a });
      start = i;
    }
  }
  segments.push({ from: arabicSamples[start].p, to: arabicSamples[arabicSamples.length - 1].p, delta: arabicSamples[start].p - arabicSamples[start].a });
  // 罗马前言段：位于首个阿拉伯段之前、连续带罗马页码的物理页——单独成段，避免按 Δ 换算出负印刷页
  const romanPrefix =
    romanPages.length > 0 &&
    romanPages.every((p, i) => i === 0 || p === romanPages[i - 1] + 1) &&
    romanPages[romanPages.length - 1] < segments[0].from;
  if (romanPrefix) {
    segments.unshift({ from: romanPages[0], to: romanPages[romanPages.length - 1], roman: true });
    return { kind: 'segmented', segments };
  }
  const constant = segments.length === 1 && segments[0].from === arabicSamples[0].p && segments[0].to === arabicSamples[arabicSamples.length - 1].p;
  if (constant) return { kind: 'constant', delta: segments[0].delta ?? 0 };
  return { kind: 'segmented', segments };
}

/** 印刷页换算（constant/段内）；不可换算返回 undefined */
export function toPrintedPage(offset: PageOffsetResult, physical: number): number | undefined {
  if (offset.kind === 'constant') return physical - offset.delta;
  if (offset.kind === 'segmented') {
    const seg = offset.segments.find((s) => physical >= s.from && physical <= s.to);
    if (seg?.delta !== undefined) return physical - seg.delta;
  }
  return undefined;
}

interface LineRef {
  text: string;
  page: number;
}

/** 分会场归属：命中提示词的短行视为标题行，其后页面归该会场直至下一个标题 */
function attributeSessions(lines: LineRef[], hints: string[]): Map<number, string> {
  const pageSession = new Map<number, string>();
  let current = '未归属';
  const lowerHints = hints.map((h) => h.toLowerCase());
  for (const { text, page } of lines) {
    const isHeading = text.length < 40 && lowerHints.some((h) => text.toLowerCase().includes(h));
    if (isHeading) current = text.trim();
    if (!pageSession.has(page)) pageSession.set(page, current);
  }
  return pageSession;
}

function looksLikeAuthorLine(line: string): boolean {
  const segs = line.split(/[,，、;；\s]+/).filter((s) => /^[一-龥·.'-]{2,5}$/.test(s));
  return segs.length >= 2;
}

/** 单条切分：关键词行 → 单位行 → 作者行 → 题名 → 正文，缺陷旗标同步打 */
function segmentFields(entryLines: LineRef[]): Omit<AbstractRecord, 'id' | 'session' | 'physicalPages' | 'printedPage'> {
  const defects: string[] = [];
  let keywords: string[] = [];
  let affiliations: string[] = [];
  let authors: string[] = [];
  const bodyLines: string[] = [];
  let titleLines: string[] = [];
  const consumed = new Set<number>();

  const lines = entryLines.map((l) => l.text);
  const kwIdx = lines.findIndex((l) => KEYWORDS_RE.test(l));
  if (kwIdx >= 0) {
    const kwLine = lines[kwIdx];
    if (kwLine.length > 100) defects.push('keywords_in_body');
    keywords = kwLine.replace(KEYWORDS_RE, '').split(/[;；,，、]/).map((s) => s.trim()).filter(Boolean);
    consumed.add(kwIdx);
  }
  const affIdx = lines.findIndex((l, i) => !consumed.has(i) && (AFFIL_RE.test(l) || POSTAL_RE.test(l)));
  if (affIdx >= 0) {
    affiliations = [lines[affIdx].trim()];
    consumed.add(affIdx);
  } else {
    defects.push('affiliation_missing');
  }
  const authIdx = lines.findIndex((l, i) => !consumed.has(i) && looksLikeAuthorLine(l));
  if (authIdx >= 0) {
    authors = lines[authIdx].split(/[,，、;；]+/).map((s) => s.trim()).filter(Boolean);
    consumed.add(authIdx);
  }
  // 题名：作者行之前的非空行；超长或末尾像人名序列 → 长题名吃作者行缺陷
  titleLines = lines.slice(0, authIdx >= 0 ? authIdx : Math.min(2, lines.length)).filter((_, i) => !consumed.has(i));
  const title = titleLines.join(' ').trim();
  if (title.length > TITLE_LONG_CHARS || /([一-龥]{2,4})([,，、\s]+\1?[,，、\s]*[一-龥]{2,4}){2,}\s*$/.test(title)) {
    defects.push('title_eats_author');
  }
  if (!title) defects.push('title_missing');
  // 正文：其余行（独立页码行剥离——页脚印刷页码不是正文）
  lines.forEach((l, i) => {
    if (!consumed.has(i) && !titleLines.includes(l) && !PAGE_MARKER_RE.test(l.trim())) bodyLines.push(l);
  });
  const body = bodyLines.join('\n').trim();
  if (body && !/[。！？.!?…]["'」』]?\s*$/.test(body)) defects.push('cross_page_break');
  return {
    title,
    authors,
    affiliations,
    keywords,
    body,
    status: defects.some((d) => d === 'title_missing') ? 'incomplete' : 'parsed',
    defects,
  };
}

/** 自动切分路径：entryPattern 命中行为条目起点，跨页条目合并并记录物理页区间 */
export function splitRecords(
  pages: string[],
  offset: PageOffsetResult,
  entryPattern: RegExp,
  sessionHints: string[],
): AbstractRecord[] {
  const allLines: LineRef[] = [];
  pages.forEach((text, idx) => {
    for (const l of text.split('\n')) if (l.trim()) allLines.push({ text: l.trimEnd(), page: idx + 1 });
  });
  const pageSession = attributeSessions(allLines, sessionHints);
  const starts: number[] = [];
  allLines.forEach((l, i) => {
    if (entryPattern.test(l.text)) starts.push(i);
  });
  entryPattern.lastIndex = 0;
  const records: AbstractRecord[] = [];
  starts.forEach((s, i) => {
    const entryLines = allLines.slice(s, i + 1 < starts.length ? starts[i + 1] : undefined);
    const first = entryLines[0];
    if (!first) return;
    // 条目首行通常「编号+题名」同行：剥掉 entryPattern 命中前缀再进字段切分
    const stripped = first.text.replace(entryPattern, '').trim();
    const fields = segmentFields([{ text: stripped || first.text, page: first.page }, ...entryLines.slice(1)]);
    const physFrom = first.page;
    const physTo = entryLines[entryLines.length - 1].page;
    records.push({
      id: `R${records.length + 1}`,
      ...fields,
      session: pageSession.get(physFrom) ?? '未归属',
      physicalPages: [physFrom, physTo],
      printedPage: toPrintedPage(offset, physFrom),
    });
  });
  return records;
}

/** 归一化路径：调用方/LLM 预切分记录 → 统一字段与安全缺省（字段演进防御） */
export function normalizeRecords(raw: unknown[], offset: PageOffsetResult): AbstractRecord[] {
  const out: AbstractRecord[] = [];
  for (const [i, r] of raw.entries()) {
    if (!isObj(r)) continue;
    const pickStr = (...c: unknown[]): string => (typeof c[0] === 'string' ? c[0].trim() : '');
    const pickArr = (c: unknown): string[] =>
      Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string' && !!x.trim()) : typeof c === 'string' ? [c.trim()] : [];
    const phys = typeof r.physicalPage === 'number' ? r.physicalPage : Array.isArray(r.physicalPages) && typeof r.physicalPages[0] === 'number' ? (r.physicalPages[0] as number) : i + 1;
    const physTo = Array.isArray(r.physicalPages) && typeof r.physicalPages[1] === 'number' ? (r.physicalPages[1] as number) : phys;
    const defects: string[] = [];
    if (!pickStr(r.title)) defects.push('title_missing');
    const body = pickStr(r.body, r.abstract, r.text);
    if (body && !/[。！？.!?…]["'」』]?\s*$/.test(body)) defects.push('cross_page_break');
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : `R${i + 1}`,
      title: pickStr(r.title) || '（未命名）',
      authors: pickArr(r.authors),
      affiliations: pickArr(r.affiliations),
      keywords: pickArr(r.keywords),
      body,
      session: pickStr(r.session) || '未归属',
      physicalPages: [phys, physTo],
      printedPage: typeof r.printedPage === 'number' ? r.printedPage : toPrintedPage(offset, phys),
      status: defects.length > 0 ? 'incomplete' : 'parsed',
      defects,
    });
  }
  return out;
}

export interface ParseAbstractCollectionResult {
  records: AbstractRecord[];
  sessions: string[];
  pageOffset: PageOffsetResult;
  coverage: { parsed: number; declaredTotal?: number; ratio?: number };
  /** 无 entryPattern 也无预切分记录时：仅完成分会场归属与偏移探测 */
  degraded: boolean;
  notes: string[];
}

export function parseAbstractCollection(input: {
  pages?: unknown;
  content?: unknown;
  records?: unknown;
  entryPattern?: unknown;
  sessionHints?: unknown;
  declaredTotal?: unknown;
}): ParseAbstractCollectionResult | { error: string } {
  const plan = planParseAbstractCollection(input);
  if (!plan.ok) return { error: plan.error ?? '输入校验失败' };
  const offset = detectPageOffset(plan.pages);
  const notes: string[] = [];
  if (offset.kind === 'unavailable') notes.push(offset.reason);
  else if (offset.kind === 'segmented') notes.push('页码偏移分段（前言/正文多套页码体系）：来源标注按段换算');

  let records: AbstractRecord[] = [];
  if (plan.rawRecords) {
    records = normalizeRecords(plan.rawRecords, offset);
  } else if (plan.entryPattern) {
    records = splitRecords(plan.pages, offset, plan.entryPattern, plan.sessionHints);
    if (records.length === 0) notes.push('entryPattern 未命中任何条目起点：请依据目录页式样修正正则');
  } else {
    notes.push('未提供 entryPattern/records：只完成分会场归属与页码偏移探测，记录切分需补条目起始特征');
  }
  return {
    records,
    sessions: [...new Set(records.map((r) => r.session))],
    pageOffset: offset,
    coverage: {
      parsed: records.length,
      ...(plan.declaredTotal ? { declaredTotal: plan.declaredTotal, ratio: records.length / plan.declaredTotal } : {}),
    },
    degraded: records.length === 0,
    notes,
  };
}
