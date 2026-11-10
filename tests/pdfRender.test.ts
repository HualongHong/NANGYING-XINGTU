import { describe, expect, it, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync as fsExists } from 'node:fs';
import {
  buildPdf,
  parseTrueTypeFont,
  countNonLatinChars,
} from '../core/course/pdfRender.js';
import { generateTeachingScript } from '../core/course/generateTeachingScript.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import type { CourseStructure } from '../core/course/designCourseStructure.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const MSYH = 'C:/Windows/Fonts/msyh.ttc';
const hasMsyh = fsExists(MSYH);

function structureFixture(): CourseStructure {
  return {
    courseScript: { title: '种群生态学', audience: '本科生', totalMinutes: 8, modules: [{ id: 'm1', title: '种群生态学', minutes: 8, lessonIds: ['l1'] }] },
    teachingStructure: [{
      id: 'm1', title: '种群生态学', sectionIds: [], minutes: 8,
      lessons: [{
        id: 'l1', title: '种群密度', moduleId: 'm1', sectionIds: [], conceptIds: [], minutes: 8,
        phases: [
          { kind: '导入', minutes: 1, conceptIds: [] },
          { kind: '讲解', minutes: 5, conceptIds: [] },
          { kind: '小结', minutes: 2, conceptIds: [] },
        ],
        assessmentPoints: [],
      }],
    }],
    teachingFlow: { steps: [], edges: [] },
  };
}

describe('R7-3 pdfRender（零依赖 PDF 写出）', () => {
  it('拉丁模式：%PDF 头、对象结构、固定时间戳、确定性字节', () => {
    const a = buildPdf({
      title: 'Quiz',
      blocks: [
        { kind: 'h2', text: 'Part 1' },
        { kind: 'p', text: 'Calculate the Vmax and Km values.' },
        { kind: 'table', rows: [['Item', 'Score'], ['Q1', '10']] },
      ],
      font: null,
    });
    expect(a.embeddedFont).toBe(false);
    expect(a.replacedChars).toBe(0);
    const head = Buffer.from(a.bytes.subarray(0, 8)).toString('latin1');
    expect(head.startsWith('%PDF-1.4')).toBe(true);
    const text = Buffer.from(a.bytes).toString('latin1');
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages');
    expect(text).toContain('/BaseFont /Helvetica');
    expect(text).toContain('D:19800101000000Z'); // 固定时间戳
    expect(text).toContain('xref');
    // 确定性：同输入同字节
    const b = buildPdf({
      title: 'Quiz',
      blocks: [
        { kind: 'h2', text: 'Part 1' },
        { kind: 'p', text: 'Calculate the Vmax and Km values.' },
        { kind: 'table', rows: [['Item', 'Score'], ['Q1', '10']] },
      ],
      font: null,
    });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('无字体时 CJK 计数：非拉丁字符替换为 ? 并如实计数（诚实降级基础）', () => {
    const r = buildPdf({ title: '试卷', blocks: [{ kind: 'p', text: '种群密度 Quiz' }], font: null });
    expect(r.replacedChars).toBeGreaterThan(0);
    expect(countNonLatinChars('种群密度 Quiz')).toBe(4);    const text = Buffer.from(r.bytes).toString('latin1');
    expect(text).toContain('/BaseFont /Helvetica');
  });

  it('TTF/TTC 解析：cmap + 字宽 + PostScript 名（系统字体真跑）', () => {
    if (!hasMsyh) return; // 非 Windows 环境跳过（CI 上无此文件）
    const font = parseTrueTypeFont(new Uint8Array(readFileSync(MSYH)));
    expect(font).not.toBeNull();
    expect(font!.cmap.size).toBeGreaterThan(10_000);
    expect(font!.cmap.get('种'.codePointAt(0)!)).toBeGreaterThan(0);
    expect(font!.widths.size).toBeGreaterThan(10_000);
    expect(font!.postScriptName.length).toBeGreaterThan(0);
  });

  it('嵌入中文字体：CIDFontType2 + FontFile2 + ToUnicode + 确定性（系统字体真跑）', () => {
    if (!hasMsyh) return;
    const font = parseTrueTypeFont(new Uint8Array(readFileSync(MSYH)));
    const input = {
      title: '种群生态学试卷',
      blocks: [
        { kind: 'h2' as const, text: '一、名词解释' },
        { kind: 'p' as const, text: '解释种群密度与标志重捕法。' },
      ],
    };
    const a = buildPdf({ ...input, font });
    expect(a.embeddedFont).toBe(true);
    const text = Buffer.from(a.bytes).toString('latin1');
    expect(text).toContain('/Subtype /CIDFontType2');
    expect(text).toContain('/FontFile2');
    expect(text).toContain('/ToUnicode');
    expect(text).toContain('/Encoding /Identity-H');
    const b = buildPdf({ ...input, font });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });
});

describe('R7-3 export handout-pdf 端到端', () => {
  it('fontPath 嵌入：full 且真实 PDF 落盘；无中文字体环境降级诚实（探测失败注入）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ny-pdf-'));
    dirs.push(dir);
    const adapter = new LocalAdapter();
    const script = (await generateTeachingScript({ structure: structureFixture() })).data!;
    const outPdf = join(dir, '试卷.pdf');
    const r = await adapter.invokeSkill('export_course_package', {
      inputs: {
        script,
        options: { formats: ['handout-pdf'] },
        outPdf,
        ...(hasMsyh ? { fontPath: MSYH } : {}),
      },
    });
    expect(existsSync(outPdf)).toBe(true);
    const head = readFileSync(outPdf).subarray(0, 5).toString('latin1');
    expect(head).toBe('%PDF-');
    const data = r.data as { writtenFiles?: string[] };
    expect(data.writtenFiles?.some((f) => f.endsWith('试卷.pdf'))).toBe(true);
    if (hasMsyh) {
      expect(r.level).toBe('full');
    } else {
      // 无系统字体：诚实降级（本测试机有 msyh，此分支仅覆盖无字体环境）
      expect(r.level).toBe('degraded');
      expect(r.degradationNote).toContain('未找到中文字体');
    }
  }, 60000);

  it('fontPath 指向坏路径 → 落入系统探测/降级路径，不抛异常', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ny-pdf2-'));
    dirs.push(dir);
    const adapter = new LocalAdapter();
    const script = (await generateTeachingScript({ structure: structureFixture() })).data!;
    const r = await adapter.invokeSkill('export_course_package', {
      inputs: {
        script,
        options: { formats: ['handout-pdf'] },
        outPdf: join(dir, 'out.pdf'),
        fontPath: 'C:/not-exist/font.ttf',
      },
    });
    expect(existsSync(join(dir, 'out.pdf'))).toBe(true);
    if (hasMsyh) expect(r.level).toBe('full'); // 系统探测兜底成功
    else expect(r.level).toBe('degraded');
  }, 60000);
});

describe('R13：handout-pdf 表格合并单元格（colSpan/rowSpan）', () => {
  const NO_SPAN_INPUT = {
    title: '试卷',
    blocks: [
      { kind: 'h2' as const, text: '一、名词解释' },
      { kind: 'p' as const, text: 'Explain 种群密度与标志重捕法。' },
      { kind: 'table' as const, rows: [['Item', 'Score'], ['Q1', '10']] },
    ],
    font: null,
  };

  /** 提取页面内容流（绘图/文本指令） */
  const contentStream = (bytes: Uint8Array): string => {
    const text = Buffer.from(bytes).toString('latin1');
    const m = /\nq\n([\s\S]*?)\nQ/.exec(text);
    return m ? m[1] : '';
  };

  it('无 span 输入逐字节不变（sha256 快照锁定）', () => {
    const r = buildPdf(NO_SPAN_INPUT);
    expect(createHash('sha256').update(Buffer.from(r.bytes)).digest('hex'))
      .toBe('f01ad4a7934c41dd37c29cc6364e2d871521d7b0e2efb74ac0182423fc1c39ed');
  });

  it('纯格子对象（无 span）与字符串格子逐字节一致（向后兼容）', () => {
    const a = buildPdf(NO_SPAN_INPUT);
    const b = buildPdf({
      title: '试卷',
      blocks: [
        { kind: 'h2', text: '一、名词解释' },
        { kind: 'p', text: 'Explain 种群密度与标志重捕法。' },
        { kind: 'table', rows: [[{ text: 'Item' }, { text: 'Score' }], [{ text: 'Q1' }, { text: '10' }]] },
      ],
      font: null,
    });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('colSpan=2：合并区无线穿越（竖边界仅 1 段）、文本水平居中+垂直居中、无全宽线', () => {
    const r = buildPdf({
      title: '试卷',
      blocks: [
        { kind: 'table', rows: [[{ text: 'HEAD', colSpan: 2, align: 'center' as const }], ['Q1', '10']] },
      ],
      font: null,
    });
    const s = contentStream(r.bytes);
    // 列宽 241.64：x1 = 297.64（合并区右边界）。行 0 被横向合并 → 该边界只有行 1 一段竖线
    const verticalAtX1 = s.match(/^297\.64 [\d.]+ m 297\.64 [\d.]+ l S$/gm) ?? [];
    expect(verticalAtX1).toHaveLength(1);
    // 无全宽横线（56 → 539.28 的整行线不存在）
    expect(s).not.toMatch(/^56 [\d.]+ m 539\.28 [\d.]+ l S$/m);
    // 横线以两段拼接：56→297.64、297.64→539.28
    expect(s).toMatch(/^56 [\d.]+ m 297\.64 [\d.]+ l S$/m);
    expect(s).toMatch(/^297\.64 [\d.]+ m 539\.28 [\d.]+ l S$/m);
    // 合并格文本：水平居中 x=297.64（= 56 + 2*241.64/2），垂直居中于合并区（top-7）
    const headText = s.match(/^BT \/F1 10 Tf 1 0 0 1 (297\.64) ([\d.]+) Tm <(.+?)> Tj ET$/m);
    expect(headText).not.toBeNull();
    // 左对齐格 Q1 x=60（56+4）；10 x=301.64
    expect(s).toMatch(/^BT \/F1 10 Tf 1 0 0 1 60 [\d.]+ Tm <.+?> Tj ET$/m);
    expect(s).toMatch(/^BT \/F1 10 Tf 1 0 0 1 301\.64 [\d.]+ Tm <.+?> Tj ET$/m);
    // 确定性
    const r2 = buildPdf({
      title: '试卷',
      blocks: [
        { kind: 'table', rows: [[{ text: 'HEAD', colSpan: 2, align: 'center' as const }], ['Q1', '10']] },
      ],
      font: null,
    });
    expect(Buffer.from(r.bytes).equals(Buffer.from(r2.bytes))).toBe(true);
  });

  it('rowSpan=2：合并区横边界中断（y=726.89 处仅右半段有线）、文本垂直居中跨两行', () => {
    const r = buildPdf({
      title: '试卷',
      blocks: [
        { kind: 'table', rows: [[{ text: 'LEFT', rowSpan: 2 }, { text: 'A' }], [{ text: 'B' }]] },
      ],
      font: null,
    });
    const s = contentStream(r.bytes);
    // r=1 边界（y=746.89-20=726.89）：c0 被纵向合并 → 无线；仅 c1 段 297.64→539.28 有线
    expect(s).toMatch(/^297\.64 726\.89 m 539\.28 726\.89 l S$/m);
    expect(s).not.toMatch(/^56 726\.89 m 297\.64 726\.89 l S$/m);
    // r=0 顶边与 r=2 底边的左半段仍在
    expect(s).toMatch(/^56 746\.89 m 297\.64 746\.89 l S$/m);
    expect(s).toMatch(/^56 706\.89 m 297\.64 706\.89 l S$/m);
    // 合并格文本垂直居中于两行区：y = 746.89 - 40/2 + 3 = 729.89
    expect(s).toMatch(/^BT \/F1 10 Tf 1 0 0 1 60 729\.89 Tm <.+?> Tj ET$/m);
  });

  it('colSpan+rowSpan 组合：内部边界全部断开，外框完整', () => {
    const r = buildPdf({
      title: '试卷',
      blocks: [
        {
          kind: 'table',
          rows: [
            [{ text: 'M', colSpan: 2, rowSpan: 2 }, { text: 'C' }],
            [{ text: 'D' }],
            ['E', 'F'],
          ],
        },
      ],
      font: null,
    });
    const s = contentStream(r.bytes);
    // 3 列：x0=56 / x1 / x2；行高 20。收集横线段的 y，推出顶边与 r=1 边界
    const colW = (595.28 - 2 * 56) / 3;
    const x1 = String(56 + colW);
    const x2 = String(56 + 2 * colW);
    const hYs = [...s.matchAll(/^[\d.]+ ([\d.]+) m [\d.]+ \1 l S$/gm)].map((m) => m[1]);
    const yTop = String(Math.max(...hYs.map(Number)));
    const yR1 = String(Number(yTop) - 20);
    const yBottom = String(Math.min(...hYs.map(Number)));
    const segsAt = (yy: string) => s.match(new RegExp(`^[\\d.]+ ${yy} m [\\d.]+ ${yy} l S$`, 'gm')) ?? [];
    // r=0 顶边三段、r=3 底边三段；r=1（M 内部横边界）仅 c2 一段有线
    expect(segsAt(yTop)).toHaveLength(3);
    expect(segsAt(yBottom)).toHaveLength(3);
    const segsR1 = segsAt(yR1);
    expect(segsR1).toHaveLength(1);
    expect(segsR1[0]).toBe(`${x2} ${yR1} m ${String(56 + 3 * colW)} ${yR1} l S`);
    // 竖边界：x1（M 右内边界）仅 r=2 一段；x2 与左外框 56 三段齐全
    const vAt = (xx: string) => {
      const esc = xx.replace(/\./g, '\\.');
      return s.match(new RegExp(`^${esc} [\\d.]+ m ${esc} [\\d.]+ l S$`, 'gm')) ?? [];
    };
    expect(vAt(x1)).toHaveLength(1);
    expect(vAt(x2)).toHaveLength(3);
    expect(vAt('56')).toHaveLength(3);
    // 左半横线三段（顶/r=2/底），r=1 边界（M 内部）断开
    const leftHalf = s.match(new RegExp(`^56 [\\d.]+ m ${x1.replace(/\./g, '\\.')} [\\d.]+ l S$`, 'gm')) ?? [];
    expect(leftHalf).toHaveLength(3);
  });
});
