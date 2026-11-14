/**
 * 教学四件套组装（compose_teaching_artifacts）核心：纯函数，零 IO。
 * 选文源 + 课程结构 + 教师数据层 → 四件套（课件/阅读材料/课后 HTML/教案）的内容源表示：
 * 编号单一来源映射（案例编号=阅读编号、按课程节顺序，方法论 3.10）、
 * 来源字段模板渲染（7.3「未提供」口径）、H1 学生/教师信息边界校验、
 * 增量加工的基线 diff（A4 增量不破坏）。正文撰写由宿主 agent/LLM 按层完成，
 * 本模块保证：编号只在一处定义、教师数据不进学生产物、骨架可空但占位诚实。
 */

export const STUDENT_ARTIFACTS = ['slides', 'reading', 'html'] as const;
export type StudentArtifact = (typeof STUDENT_ARTIFACTS)[number];

/** 教师数据层字段（方法论 4.1：学生可见文案不得出现；4.2 学生材料软引用不冒充摘要集正式字段） */
export const DEFAULT_TEACHER_TOKENS = [
  '教学目标', '重难点', '学情', '设计理由', '评分锚点', '参考答案', '追问话术',
  '课时流程', '数字口径', '素材取舍', '课程定位', '科教融合', '制作信息', '模板名',
  'objectives', 'scoringAnchors', 'referenceAnswers', 'probingQuestions', 'designRationale',
  'learnerProfile', 'pacing', '教师教案', '内部口径',
] as const;

export interface ComposeRecord {
  id: string;
  title: string;
  authors: string[];
  keywords: string[];
  body: string;
  session: string;
  physicalPages: [number, number];
  printedPage?: number;
  /** 原文节选（agent/LLM 产出；缺省标占位，由 audit 的占位符扫描兜底） */
  excerpt?: string;
  /** 教学解说（五段式 K4；agent/LLM 产出） */
  commentary?: string;
  /** 「想一想」思考题（1–2 道） */
  thinkQuestions?: string[];
}

export interface NumberingEntry {
  /** 案例编号 = 阅读编号，两位数字，按课程节顺序 */
  caseNo: string;
  recordId: string;
  section: string;
  title: string;
  mustReview: boolean;
}

export interface LayerViolation {
  artifact: StudentArtifact | string;
  token: string;
  count: number;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((s) => s.trim()) : [];
}

/** 编号映射：按 courseStructure 节序排节、节内按 score 降序；编号只在内容源定义一次（4.2） */
export function buildNumberingMap(
  selected: { recordId: string; title: string; section: string; score?: number; mustReview?: boolean }[],
  sectionOrder: string[],
): NumberingEntry[] {
  const orderOf = (s: string) => {
    const i = sectionOrder.indexOf(s);
    return i < 0 ? sectionOrder.length : i;
  };
  const sorted = [...selected].sort((a, b) => {
    const d = orderOf(a.section) - orderOf(b.section);
    return d !== 0 ? d : (b.score ?? 0) - (a.score ?? 0);
  });
  return sorted.map((s, i) => ({
    caseNo: String(i + 1).padStart(2, '0'),
    recordId: s.recordId,
    section: s.section,
    title: s.title,
    mustReview: s.mustReview === true,
  }));
}

/**
 * 来源字段渲染（方法论 7.3 统一模板）：
 * `[阅读编号 NN] 作者. 题名. 会议/出版物名称, 年份: 印刷页 P（分会场；PDF 第 P+Δ 页）. 链接或 DOI：未提供.`
 * 缺失字段一律「未提供」，不补造（H2）；偏移不可探测时只给物理页并注明。
 */
export function renderSourceField(
  rec: Pick<ComposeRecord, 'title' | 'authors' | 'session' | 'physicalPages' | 'printedPage'>,
  caseNo: string,
  meta: { venue?: string; year?: string },
): string {
  const authors = rec.authors.length > 0 ? rec.authors.join('，') : '作者：未提供';
  const venue = meta.venue?.trim() ? meta.venue.trim() : '会议/出版物：未提供';
  const year = meta.year?.trim() ? meta.year.trim() : '年份：未提供';
  const pagePart =
    rec.printedPage !== undefined
      ? `印刷页 ${rec.printedPage}（${rec.session || '分会场：未提供'}；PDF 第 ${rec.physicalPages[0]} 页）`
      : `PDF 第 ${rec.physicalPages[0]} 页（印刷页偏移未探测）`;
  return `[阅读编号 ${caseNo}] ${authors}. ${rec.title || '题名：未提供'}. ${venue}, ${year}: ${pagePart}. 链接或 DOI：未提供.`;
}

/** H1 信息边界校验：教师数据层 token 出现在学生产物文本中即违规（命中数>0 列出） */
export function validateLayerBoundaries(
  studentTexts: Partial<Record<StudentArtifact, string>>,
  extraTokens: string[] = [],
): LayerViolation[] {
  const tokens = [...DEFAULT_TEACHER_TOKENS, ...extraTokens];
  const violations: LayerViolation[] = [];
  for (const artifact of Object.keys(studentTexts) as StudentArtifact[]) {
    const text = studentTexts[artifact];
    if (typeof text !== 'string' || !text) continue;
    for (const token of tokens) {
      if (!token) continue;
      const count = text.split(token).length - 1;
      if (count > 0) violations.push({ artifact, token, count });
    }
  }
  return violations;
}

/** 基线 diff（A4 增量不破坏）：新计划相对已验收基线的结构指标变化，变化项列出供确认 */
export function diffBaseline(baseline: Record<string, unknown>, current: Record<string, unknown>): { key: string; before: unknown; after: unknown }[] {
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(current)])];
  const diff: { key: string; before: unknown; after: unknown }[] = [];
  for (const key of keys) {
    const b = baseline[key];
    const c = current[key];
    if (JSON.stringify(b) !== JSON.stringify(c)) diff.push({ key, before: b ?? null, after: c ?? null });
  }
  return diff;
}

export interface ComposeArtifactsResult {
  artifacts: {
    /** 课件：各节「研究例证」帧 + 引入标签位（正文 agent 撰写，编号/来源确定性） */
    slides: { section: string; caseNos: string[]; sourceNote: string };
    /** 阅读材料：原文节选页+解读页配对项（奇原文偶解读，物理相邻） */
    reading: { caseNo: string; sourceField: string; excerptReady: boolean; commentaryReady: boolean; thinkCount: number }[];
    /** 课后 HTML：案例速查卡 + 自测位 */
    html: { caseCount: number; quizPlaceholder: boolean };
    /** 教案：教师数据层承载位（不在学生产物出现） */
    lessonPlan: { expectsTeacherLayer: boolean };
  }[];
  numberingMap: NumberingEntry[];
  sourceFields: Record<string, string>;
  violations: LayerViolation[];
  baselineDiff: { key: string; before: unknown; after: unknown }[];
  degraded: boolean;
  notes: string[];
}

export function composeTeachingArtifacts(input: {
  selected?: unknown;
  records?: unknown;
  courseStructure?: unknown;
  teacherLayer?: unknown;
  studentDrafts?: unknown;
  venue?: unknown;
  year?: unknown;
  baseline?: unknown;
  extraTeacherTokens?: unknown;
}): ComposeArtifactsResult | { error: string } {
  const sel = Array.isArray(input.selected) ? input.selected : undefined;
  if (!sel) return { error: 'selected 必填：select_research_evidence 输出的 selected 数组（可含 mustReview 标记）' };
  const records = Array.isArray(input.records) ? input.records : [];
  const recById = new Map<string, ComposeRecord>();
  for (const r of records) {
    if (!isObj(r) || typeof r.id !== 'string') continue;
    const phys = Array.isArray(r.physicalPages) && typeof r.physicalPages[0] === 'number' ? (r.physicalPages as number[])[0] : 0;
    const physTo = Array.isArray(r.physicalPages) && typeof r.physicalPages[1] === 'number' ? (r.physicalPages as number[])[1] : phys;
    recById.set(r.id, {
      id: r.id,
      title: typeof r.title === 'string' ? r.title : '',
      authors: strArr(r.authors),
      keywords: strArr(r.keywords),
      body: typeof r.body === 'string' ? r.body : '',
      session: typeof r.session === 'string' ? r.session : '',
      physicalPages: [phys, physTo],
      ...(typeof r.printedPage === 'number' ? { printedPage: r.printedPage } : {}),
      ...(typeof r.excerpt === 'string' ? { excerpt: r.excerpt } : {}),
      ...(typeof r.commentary === 'string' ? { commentary: r.commentary } : {}),
      ...(Array.isArray(r.thinkQuestions) ? { thinkQuestions: strArr(r.thinkQuestions) } : {}),
    });
  }
  const cs = isObj(input.courseStructure) ? input.courseStructure : {};
  const sectionOrder = Array.isArray(cs.sections)
    ? (cs.sections as unknown[]).map((s) => (isObj(s) && typeof s.title === 'string' ? s.title : '')).filter(Boolean)
    : [...new Set(sel.map((s) => (isObj(s) && typeof (s as { section?: unknown }).section === 'string' ? ((s as { section: string }).section) : '')))];
  if (sectionOrder.length === 0) return { error: 'courseStructure.sections（或 selected[].section）至少一节：编号按课程节顺序定义' };

  const selected = sel
    .filter((s): s is Record<string, unknown> => isObj(s) && typeof s.recordId === 'string')
    .map((s) => ({
      recordId: s.recordId as string,
      title: typeof s.title === 'string' ? s.title : '',
      section: typeof s.section === 'string' ? s.section : '',
      score: typeof s.score === 'number' ? s.score : undefined,
      mustReview: s.mustReview === true,
    }));
  const numberingMap = buildNumberingMap(selected, sectionOrder);

  const notes: string[] = [];
  const meta = { venue: typeof input.venue === 'string' ? input.venue : undefined, year: typeof input.year === 'string' ? input.year : undefined };
  const sourceFields: Record<string, string> = {};
  for (const n of numberingMap) {
    const rec = recById.get(n.recordId);
    if (!rec) {
      sourceFields[n.caseNo] = `[阅读编号 ${n.caseNo}] ${n.title || '题名：未提供'}. 来源字段：未提供（records 中无 ${n.recordId}）. 链接或 DOI：未提供.`;
      notes.push(`${n.recordId} 缺记录详情：来源字段标未提供`);
      continue;
    }
    sourceFields[n.caseNo] = renderSourceField(rec, n.caseNo, meta);
  }

  // 四件套内容源表示：学生产物只挂确定性字段，正文交 agent/LLM 按层撰写
  const artifacts: ComposeArtifactsResult['artifacts'] = sectionOrder.map((section) => {
    const inSection = numberingMap.filter((n) => n.section === section);
    return {
      slides: { section, caseNos: inSection.map((n) => n.caseNo), sourceNote: '各节末「研究例证」帧：结论+条件+阅读编号；引入标签数量按需求治理裁定' },
      reading: inSection.map((n) => {
        const rec = recById.get(n.recordId);
        return {
          caseNo: n.caseNo,
          sourceField: sourceFields[n.caseNo],
          excerptReady: !!rec?.excerpt,
          commentaryReady: !!rec?.commentary,
          thinkCount: rec?.thinkQuestions?.length ?? 0,
        };
      }),
      html: { caseCount: inSection.length, quizPlaceholder: true },
      lessonPlan: { expectsTeacherLayer: true },
    };
  });

  // H1 校验：agent 已起草的学生产物文本（html 字符串等）送检；未提供则零违规（骨架不携带教师数据）
  const drafts = isObj(input.studentDrafts) ? input.studentDrafts : {};
  const studentTexts: Partial<Record<StudentArtifact, string>> = {};
  for (const k of STUDENT_ARTIFACTS) {
    const v = drafts[k];
    if (typeof v === 'string') studentTexts[k] = v;
  }
  const extraTokens = strArr(input.extraTeacherTokens);
  const violations = validateLayerBoundaries(studentTexts, extraTokens);

  // 基线 diff（增量不破坏：不改已验收指标；变化项须显式确认）
  const baseline = isObj(input.baseline) ? input.baseline : {};
  const current: Record<string, unknown> = { caseCount: numberingMap.length, sections: sectionOrder.length };
  const baselineDiff = diffBaseline(baseline, current);
  if (baselineDiff.length > 0) notes.push(`基线变化 ${baselineDiff.length} 项（增量加工须确认不破坏已验收指标）`);

  const mustReview = numberingMap.filter((n) => n.mustReview);
  if (mustReview.length > 0) notes.push(`${mustReview.length} 篇标必复核（mustReview）：复核通过前不进课堂正文`);
  const excerptMissing = numberingMap.filter((n) => !recById.get(n.recordId)?.excerpt);
  if (excerptMissing.length > 0) notes.push(`${excerptMissing.length} 篇缺原文节选/解说（占位待补，audit 占位符扫描兜底）`);

  return {
    artifacts,
    numberingMap,
    sourceFields,
    violations,
    baselineDiff,
    degraded: numberingMap.length === 0,
    notes,
  };
}
