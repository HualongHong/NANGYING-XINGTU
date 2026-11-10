import { describe, expect, it } from 'vitest';
import { extractPdfText, PDF_TEXT_SUBSTANTIAL_CHARS } from '../adapters/core/decoders/pdfTextExtract.js';
import { tryScannedPdfOcr } from '../adapters/core/decoders/scannedParse.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import {
  buildPdf,
  cidFontWithToUnicode,
  contentStream,
  jpegImageObject,
} from './helpers/miniPdf.js';

/** 两页中文最小 PDF：CID 字体 + ToUnicode（bfchar 1 字节码） */
function chinesePdf(): Buffer {
  const fonts = cidFontWithToUnicode(5, 6, [
    [0x21, '种'], [0x22, '群'], [0x23, '密'], [0x24, '度'],
  ]);
  return buildPdf([
    { num: 1, dict: '/Type /Catalog /Pages 2 0 R' },
    { num: 2, dict: '/Type /Pages /Kids [3 0 R 4 0 R] /Count 2' },
    { num: 3, dict: '/Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R' },
    { num: 4, dict: '/Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 8 0 R' },
    ...fonts,
    contentStream(7, '2122 2324'), // 种群密度
    contentStream(8, '2324 2122'), // 密度种群
  ]);
}

/** 误判陷阱 PDF：3 页、每页带背景 JPEG 图（≥3 图像触发旧 OCR 自动探测），但有实质文本层 */
function trapPdf(): Buffer {
  const fonts = cidFontWithToUnicode(20, 21, [
    [0x21, '米'], [0x22, '氏'], [0x23, '常'], [0x24, '数'],
  ]);
  const pages = [];
  for (let p = 0; p < 3; p++) {
    pages.push({
      num: 10 + p,
      dict: `/Type /Page /Parent 2 0 R /Resources << /Font << /F1 20 0 R >> /XObject << /Im${p} ${30 + p} 0 R >> >> /Contents ${40 + p} 0 R`,
    });
  }
  return buildPdf([
    { num: 1, dict: '/Type /Catalog /Pages 2 0 R' },
    { num: 2, dict: '/Type /Pages /Kids [10 0 R 11 0 R 12 0 R] /Count 3' },
    ...fonts,
    ...pages,
    jpegImageObject(30), jpegImageObject(31), jpegImageObject(32),
    // 每页 >100 字符文本
    ...[40, 41, 42].map((n) => contentStream(n, '21222324'.repeat(10))),
  ]);
}

describe('R6-1 原生 PDF 文本抽取（合成夹具）', () => {
  it('CID 字体 + ToUnicode：中文按 bfchar 正确解码，页序正确', () => {
    const r = extractPdfText(new Uint8Array(chinesePdf()));
    expect(r).not.toBeNull();
    expect(r!.pages).toBe(2);
    expect(r!.partial).toBe(false);
    expect(r!.text).toContain('种群密度');
    expect(r!.text).toContain('密度种群');
    expect(r!.charsPerPage).toEqual([4, 4]);
  });

  it('非 PDF 输入返回 null；页树资源引用（/Resources N R）可解析', () => {
    expect(extractPdfText(new Uint8Array([1, 2, 3]))).toBeNull();
    // chinesePdf 的页资源是内联 << >>；再验证引用形态
    const fonts = cidFontWithToUnicode(5, 6, [[0x21, '酶']]);
    const pdf = buildPdf([
      { num: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { num: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { num: 3, dict: '/Type /Page /Parent 2 0 R /Resources 9 0 R /Contents 7 0 R' },
      { num: 9, dict: '/Font << /F1 5 0 R >>' },
      ...fonts,
      contentStream(7, '2121'),
    ]);
    const r = extractPdfText(new Uint8Array(pdf));
    expect(r!.text).toContain('酶酶');
  });

  it('无 ToUnicode 的西文 literal 按 cp1252 直用', () => {
    const stream = Buffer.from('BT /F1 12 Tf (Hello Vmax) Tj ET', 'latin1');
    const pdf = buildPdf([
      { num: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { num: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { num: 3, dict: '/Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R' },
      { num: 5, dict: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding' },
      { num: 7, dict: '/Filter /FlateDecode', stream, flate: true },
    ]);
    const r = extractPdfText(new Uint8Array(pdf));
    expect(r!.text).toContain('Hello Vmax');
  });

  it('TJ 数组与多算子混合：有映射的解码，无映射的跳过并标 partial', () => {
    const stream = Buffer.from(
      'BT /F1 12 Tf [(A) -120 <42> (C)] TJ T* (尾) \' ET', 'latin1',
    );
    const fonts = cidFontWithToUnicode(5, 6, [[0x42, 'B'], [0x61, '尾']]);
    const pdf = buildPdf([
      { num: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { num: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { num: 3, dict: '/Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R' },
      ...fonts,
      { num: 7, dict: '/Filter /FlateDecode', stream, flate: true },
    ]);
    const r = extractPdfText(new Uint8Array(pdf));
    expect(r!.text).toContain('B');
    expect(r!.partial).toBe(true); // A/C 无 CID 映射 → partial 如实标注
  });
});

describe('R6-2 路由修正：文本层优先，OCR 不误判', () => {
  it('有实质文本层的 PDF（含 ≥3 背景图）自动探测不再走 OCR', async () => {
    const { default: ok } = { default: true };
    void ok;
    const outcome = await tryScannedPdfOcr(new Uint8Array(trapPdf()), undefined);
    expect(outcome.kind).toBe('skip'); // 文本层优先：OCR 自动探测被抑制
  });

  it('extractPdfText 对陷阱 PDF 抽出实质文本（>100 字符）', () => {
    const r = extractPdfText(new Uint8Array(trapPdf()));
    expect(r).not.toBeNull();
    expect(r!.text.replace(/\s+/g, '').length).toBeGreaterThan(PDF_TEXT_SUBSTANTIAL_CHARS);
    expect(r!.text).toContain('米氏常数');
  });

  it('适配器端到端：陷阱 PDF 走文本层路径，meta.textLayer 标注，输出非乱码', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ny-trap-'));
    try {
      const p = join(dir, '幻灯片.pdf');
      writeFileSync(p, trapPdf());
      const adapter = new LocalAdapter();
      // 不传 ocr（自动）：不得对背景图 OCR 产乱码
      const r = await adapter.invokeSkill('parse_course_material', { inputs: { materialFile: p } });
      expect(r.level).toBe('full');
      const data = r.data as {
        meta?: { ocr?: { textLayer?: boolean } };
        paragraphs: Array<{ text: string }>;
      };
      expect(data.meta?.ocr?.textLayer).toBe(true);
      expect(r.degradationNote).toContain('textLayer:true');
      const all = data.paragraphs.map((x) => x.text).join('');
      expect(all.replace(/\s+/g, '')).toContain('米氏常数');
      // ocr:false 同样走文本层（修复"传 ocr:false 也一样乱码"）
      const r2 = await adapter.invokeSkill('parse_course_material', { inputs: { materialFile: p, ocr: false } });
      expect((r2.data as typeof data).meta?.ocr?.textLayer).toBe(true);
      expect(r2.level).toBe('full');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
