/**
 * 教学包验收（audit_teaching_package）核心：纯函数，零 IO。
 * 四件套交付前的验收链（方法论 5.2 C1–C8）：零外链、学生可见禁用词、
 * 未定稿占位符、跨产物编号覆盖与顺序一致、来源字段口径、原文/解读奇偶配对。
 * 编译日志（C1）、PDF 写盘核验（C2）、HTML 打印（C4）、定稿同步（C8）属宿主环境
 * 重操作（xelatex/阅读器锁），本模块给 delegated 判项+程序指引；红线触发清单（M 章）
 * 供 agent 停下来向用户确认，不自行决定。
 */

export type Verdict = 'pass' | 'fail' | 'delegated';

export interface CheckRow {
  id: string;
  name: string;
  verdict: Verdict;
  evidence: string;
}

export interface RedlineTrigger {
  /** 方法论 M 章红线编号 */
  redline: string;
  signal: string;
  action: string;
}

export interface AuditReport {
  report: CheckRow[];
  redlineTriggers: RedlineTrigger[];
  /** 非 delegated 判项全部 pass */
  passed: boolean;
}

/** 零外链模式（H6/E1）：学生 HTML 离线可用；内联 SVG 的 url(#id) 与 data: 内联资源豁免 */
export const EXTERNAL_PATTERNS: { id: string; re: RegExp }[] = [
  { id: 'http-url', re: /https?:\/\//i },
  { id: 'link-tag', re: /<link[\s>]/i },
  { id: 'script-src', re: /<script[^>]*\ssrc\s*=/i },
  { id: 'css-import', re: /@import\b/i },
  { id: 'font-face', re: /@font-face\b/i },
  { id: 'cdn-domain', re: /\bcdn\./i },
  { id: 'fetch-call', re: /\bfetch\s*\(/ },
  { id: 'xhr-ws', re: /XMLHttpRequest|WebSocket/i },
  { id: 'srcset', re: /srcset\s*=/i },
];

/** css url(...) 目标提取：#id（内联 SVG 锚）与 data: 为自包含，其余（http/相对路径）算外链 */
export function externalUrlRefs(html: string): string[] {
  const out: string[] = [];
  const re = /url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const target = m[1];
    if (target.startsWith('#') || target.toLowerCase().startsWith('data:')) continue;
    out.push(target.length > 40 ? `${target.slice(0, 40)}…` : target);
  }
  return out;
}

/** 学生可见文案禁用词表（方法论 7.2：课程设计信息/课时组织/制作信息/教师专属线索/归属残留） */
export const DEFAULT_FORBIDDEN_WORDS = [
  '课程定位', '科教融合', '模板名', '模板沿用', '素材取舍', '三部分分工',
  '学情分析', '教学目标编号', '评分锚点', '参考答案', '课堂追问话术', '设计理由',
  '课时节奏', '制作信息', '复用图片来源', 'slide 编号', '素材抽取说明', '脚本名',
  '教师教案', '内部口径', '数字口径对照', '未提供占位', '归属说明',
] as const;

/** 未定稿表述（7.2 末类）：成品中必须零命中 */
export const PLACEHOLDER_WORDS = ['待补', '占位', '占位符', '草稿', 'TODO', 'FIXME', 'lorem'] as const;

/** 配对校验提示词：奇数页原文、偶数页解读（L2：版式约束不是排版偏好） */
export const PAIR_HINTS = {
  original: ['原文', '节选', '照录'],
  commentary: ['解读', '解说', '评析'],
} as const;

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function linesOf(text: string): string[] {
  return text.split('\n');
}

function countHits(text: string, words: readonly string[] | string[]): { word: string; count: number; lines: number[] }[] {
  const out: { word: string; count: number; lines: number[] }[] = [];
  const ls = linesOf(text);
  for (const word of words) {
    let count = 0;
    const hitLines: number[] = [];
    ls.forEach((l, i) => {
      const c = l.split(word).length - 1;
      if (c > 0) {
        count += c;
        hitLines.push(i + 1);
      }
    });
    if (count > 0) out.push({ word, count, lines: hitLines.slice(0, 5) });
  }
  return out;
}

/** 编号抽取：「选读 NN / 案例 NN / 阅读编号 NN」→ 数字（容忍前导零差异） */
export function extractNumbering(text: string): string[] {
  const out: string[] = [];
  const re = /(?:选读|案例|阅读编号)\s*0?(\d{1,2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(String(Number(m[1])).padStart(2, '0'));
  return out;
}

/** 学生可见文本聚合（slides/reading/html 合并送检；教案属教师文档，不受禁用词表约束——7.2 末注） */
function studentText(artifacts: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string') parts.push(v);
    else if (isObj(v) && typeof v.text === 'string') parts.push(v.text);
    else if (isObj(v) && Array.isArray(v.pages)) parts.push(v.pages.filter((p): p is string => typeof p === 'string').join('\n\f\n'));
  };
  for (const k of ['slides', 'reading', 'html']) push(artifacts[k]);
  return parts.join('\n');
}

export function auditTeachingPackage(input: {
  artifacts?: unknown;
  expectedNumbering?: unknown;
  options?: unknown;
}): AuditReport | { error: string } {
  const artifacts = isObj(input.artifacts) ? input.artifacts : undefined;
  if (!artifacts) return { error: 'artifacts 必填：{ slides?, reading?, html?, lessonPlan? }（text 字符串或 reading.pages 数组）' };
  const expected = Array.isArray(input.expectedNumbering)
    ? input.expectedNumbering.filter((x): x is string => typeof x === 'string').map((x) => String(Number(x)).padStart(2, '0'))
    : [];
  const opts = isObj(input.options) ? input.options : {};
  const extraForbidden = Array.isArray(opts.extraForbiddenWords) ? opts.extraForbiddenWords.filter((x): x is string => typeof x === 'string') : [];
  const pairHints = isObj(opts.pairHints)
    ? {
        original: Array.isArray(opts.pairHints.original) ? opts.pairHints.original.filter((x): x is string => typeof x === 'string') : [...PAIR_HINTS.original],
        commentary: Array.isArray(opts.pairHints.commentary) ? opts.pairHints.commentary.filter((x): x is string => typeof x === 'string') : [...PAIR_HINTS.commentary],
      }
    : PAIR_HINTS;

  const report: CheckRow[] = [];
  const triggers: RedlineTrigger[] = [];
  const html = typeof artifacts.html === 'string' ? artifacts.html : isObj(artifacts.html) && typeof artifacts.html.text === 'string' ? artifacts.html.text : '';

  // C6/H6 零外链（仅学生 HTML 是硬约束）
  {
    const hits: string[] = [];
    for (const { id, re } of EXTERNAL_PATTERNS) {
      const m = html.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
      if (m && m.length > 0) hits.push(`${id}×${m.length}`);
    }
    const urlRefs = externalUrlRefs(html);
    if (urlRefs.length > 0) hits.push(`css-url×${urlRefs.length}（${urlRefs.slice(0, 3).join('、')}）`);
    const verdict: Verdict = html ? (hits.length === 0 ? 'pass' : 'fail') : 'delegated';
    report.push({
      id: 'C6-zero-external',
      name: '零外链（学生 HTML 离线可用）',
      verdict,
      evidence: html ? (hits.length === 0 ? '外部依赖模式零命中' : `命中：${hits.join('、')}`) : '未提供 html：编译产物就绪后跑 grep / https?:\\/\\/ 等模式集',
    });
    if (hits.length > 0) triggers.push({ redline: 'M11', signal: `学生 HTML 外部依赖 ${hits.length} 类`, action: '说明不可行并给替代形态（内联/本地资源），不静默联网' });
  }

  // C7 学生可见禁用词（教案/交付说明不受约束）
  {
    const text = studentText(artifacts);
    const hits = countHits(text, [...DEFAULT_FORBIDDEN_WORDS, ...extraForbidden]);
    const verdict: Verdict = text ? (hits.length === 0 ? 'pass' : 'fail') : 'delegated';
    report.push({
      id: 'C7-forbidden-words',
      name: '学生材料信息边界（禁用词命中=0）',
      verdict,
      evidence: text
        ? hits.length === 0
          ? '禁用词表零命中'
          : `命中 ${hits.length} 词：${hits.map((h) => `${h.word}×${h.count}（行 ${h.lines.join(',')}）`).join('；')}`
        : '未提供学生产物文本：渲染后重跑',
    });
    if (hits.length > 0) triggers.push({ redline: 'H1', signal: `学生可见文本教师/设计信息泄漏 ${hits.length} 类`, action: '逐处改内容源（长期口径不改输出补丁），重渲染全部产物' });
  }

  // 占位符扫描（未定稿表述零命中）
  {
    const text = studentText(artifacts);
    const hits = countHits(text, [...PLACEHOLDER_WORDS]);
    const verdict: Verdict = text ? (hits.length === 0 ? 'pass' : 'fail') : 'delegated';
    report.push({
      id: 'C3-placeholders',
      name: '未定稿占位符（待补/占位/草稿/TODO 零命中）',
      verdict,
      evidence: text ? (hits.length === 0 ? '占位符零命中' : `命中：${hits.map((h) => `${h.word}×${h.count}（行 ${h.lines.join(',')}）`).join('；')}`) : '未提供学生产物文本：渲染后重跑',
    });
    if (hits.length > 0) triggers.push({ redline: 'M-未定稿', signal: `成品残留未定稿表述 ${hits.length} 类`, action: '补齐内容或缩小交付范围，不半成品交付（H7）' });
  }

  // C5 编号覆盖与顺序一致（跨产物比对，差值必须能解释，不靠目测——F3）
  {
    if (expected.length === 0) {
      report.push({ id: 'C5-numbering', name: '跨产物编号一致（案例/阅读编号）', verdict: 'delegated', evidence: '未提供 expectedNumbering：compose_teaching_artifacts 的 numberingMap.caseNo 可直接传入' });
    } else {
      const perArtifact: string[] = [];
      let fail = false;
      for (const k of ['slides', 'reading', 'html']) {
        const a = artifacts[k];
        const text = typeof a === 'string' ? a : isObj(a) && typeof a.text === 'string' ? a.text : isObj(a) && Array.isArray(a.pages) ? a.pages.join('\n') : '';
        if (!text) continue;
        const found = extractNumbering(text);
        const set = new Set(found);
        const missing = expected.filter((n) => !set.has(n));
        const extra = found.filter((n) => !expected.includes(n));
        const inOrder = found.every((n, i) => i === 0 || Number(n) >= Number(found[i - 1]));
        if (missing.length > 0 || extra.length > 0 || !inOrder) fail = true;
        perArtifact.push(
          `${k}: 覆盖 ${set.size}/${expected.length}` +
            (missing.length > 0 ? ` 缺 ${missing.join(',')}` : '') +
            (extra.length > 0 ? ` 多 ${[...new Set(extra)].join(',')}` : '') +
            (inOrder ? '' : ' 顺序乱'),
        );
      }
      report.push({
        id: 'C5-numbering',
        name: '跨产物编号一致（案例/阅读编号）',
        verdict: fail ? 'fail' : 'pass',
        evidence: perArtifact.join('；') || '无任何产物文本可比',
      });
      if (fail) triggers.push({ redline: 'M3', signal: '编号/标识口径跨产物不一致', action: '给联动范围清单与新旧映射，确认后一次性改全（6 处起步：页脚/案例卡/出处表/导航表/封面/收束）' });
    }
  }

  // C6 来源字段口径：每行须有 DOI 或「未提供」，题名/作者不得双双缺失（H2 不补造）
  {
    const reading = artifacts.reading;
    const text = typeof reading === 'string' ? reading : isObj(reading) && typeof reading.text === 'string' ? reading.text : isObj(reading) && Array.isArray(reading.pages) ? reading.pages.join('\n') : '';
    const srcLines = text.split('\n').filter((l) => /\[阅读编号\s*\d{2}\]/.test(l));
    if (text && srcLines.length > 0) {
      const noProv = srcLines.filter((l) => !/未提供|10\.\d{4,9}\//.test(l));
      const noNames = srcLines.filter((l) => /题名：未提供/.test(l) && /作者：未提供/.test(l));
      const fail = noProv.length > 0 || noNames.length > 0;
      report.push({
        id: 'C6-source-fields',
        name: '来源字段口径（未提供/DOI，不补造）',
        verdict: fail ? 'fail' : 'pass',
        evidence: `来源行 ${srcLines.length} 条` + (noProv.length > 0 ? `；缺「未提供/DOI」口径 ${noProv.length} 条` : '') + (noNames.length > 0 ? `；题名与作者双缺 ${noNames.length} 条` : ''),
      });
      if (fail) triggers.push({ redline: 'M5', signal: '来源字段残缺或口径缺失', action: '回摘要集原件补齐并留痕；缺链接/DOI 一律标「未提供」，不补造' });
    } else {
      report.push({ id: 'C6-source-fields', name: '来源字段口径（未提供/DOI，不补造）', verdict: 'delegated', evidence: '未提供阅读材料文本：渲染后抽取「[阅读编号 NN]」行重跑' });
    }
  }

  // 阅读材料配对：奇数页原文、偶数页解读，物理相邻（L2）；内容溢出拆页即失效
  {
    const reading = artifacts.reading;
    const pages = isObj(reading) && Array.isArray(reading.pages) ? reading.pages.filter((p): p is string => typeof p === 'string') : [];
    if (pages.length > 0) {
      const bad: string[] = [];
      for (let k = 0; k < pages.length; k += 2) {
        const oddFirst = linesOf(pages[k]).find((l) => l.trim()) ?? '';
        if (!pairHints.original.some((h) => oddFirst.includes(h))) bad.push(`第 ${k + 1} 页首行无原文标记（"${oddFirst.slice(0, 20)}"）`);
        if (k + 1 < pages.length) {
          const evenFirst = linesOf(pages[k + 1]).find((l) => l.trim()) ?? '';
          if (!pairHints.commentary.some((h) => evenFirst.includes(h))) bad.push(`第 ${k + 2} 页首行无解读标记（"${evenFirst.slice(0, 20)}"）`);
        }
      }
      if (pages.length % 2 !== 0) bad.push(`奇数页数 ${pages.length}：末页无配对`);
      report.push({
        id: 'L2-pairing',
        name: '原文/解读奇偶配对（双面印发相邻）',
        verdict: bad.length === 0 ? 'pass' : 'fail',
        evidence: bad.length === 0 ? `${pages.length} 页全部配对` : bad.join('；'),
      });
      if (bad.length > 0) triggers.push({ redline: 'M7', signal: '配对版式失效（溢出拆页/标记缺失）', action: '整体收紧行距字号间距（非逐页裁剪），修完逐页首行正则复验' });
    } else {
      report.push({ id: 'L2-pairing', name: '原文/解读奇偶配对（双面印发相邻）', verdict: 'delegated', evidence: '未提供 reading.pages：按 pdftotext 分页文本传入' });
    }
  }

  // delegated：宿主环境重操作（验证阶梯：便宜→昂贵，前一步不过不进下一步——N1）
  report.push({ id: 'C1-compile-log', name: '编译日志（错误/溢出/缺字=0，两遍编译后那一次为准）', verdict: 'delegated', evidence: 'agent 执行：xelatex -interaction=nonstopmode -halt-on-error 两遍；告警先归因再接受（M8：模板随页数线性增长属正常）' });
  report.push({ id: 'C2-pdf-written', name: 'PDF 实际写盘（时间戳/页数/大小为本版）', verdict: 'delegated', evidence: 'agent 执行：核对目标文件时间戳与页数；阅读器占用会导致日志正常但旧文件仍在（F08）——独立目录编译+定稿同步' });
  report.push({ id: 'C4-html-print', name: 'HTML 打印态（答案展开/控件隐藏/页码连续）', verdict: 'delegated', evidence: 'agent 执行：--print-to-pdf 实际生成后 pdftotext 查「答案展开行数>0、控件文案行数=0」；注意 dump-dom 属性双引号假阴性（E4）' });
  report.push({ id: 'C8-final-sync', name: '定稿同步/无残留进程', verdict: 'delegated', evidence: 'agent 执行：同名与定稿逐字节一致；无挂起进程（F09：覆盖确认弹窗会挂起无人值守任务）' });

  const decided = report.filter((r) => r.verdict !== 'delegated');
  const passed = decided.length > 0 && decided.every((r) => r.verdict === 'pass');
  return { report, redlineTriggers: triggers, passed };
}
