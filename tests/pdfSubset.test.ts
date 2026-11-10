import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  buildPdf,
  parseTrueTypeFont,
  subsetTrueTypeFont,
} from '../core/course/pdfRender.js';

const MSYH = 'C:/Windows/Fonts/msyh.ttc';
const hasMsyh = existsSync(MSYH);

describe('R8-3 TTF 子集化嵌入（msyh 真跑）', () => {
  it('小字符集 → 子集化：产物远小于整字体，PDF 结构有效，ToUnicode 完好，确定性', () => {
    if (!hasMsyh) return;
    const font = parseTrueTypeFont(new Uint8Array(readFileSync(MSYH)));
    expect(font).not.toBeNull();
    const input = {
      title: '种群生态学试卷',
      blocks: [
        { kind: 'h2' as const, text: '一、名词解释' },
        { kind: 'p' as const, text: '解释种群密度与标志重捕法，并说明样方调查法的适用场景与注意事项。' },
      ],
    };
    const a = buildPdf({ ...input, font });
    // 整字体嵌入约 15MB+；子集化后应 < 1MB
    expect(a.bytes.length).toBeLessThan(1_000_000);
    expect(a.embeddedFont).toBe(true);
    const text = Buffer.from(a.bytes).toString('latin1');
    expect(text).toContain('/Subtype /CIDFontType2');
    expect(text).toContain('/FontFile2');
    expect(text).toContain('/ToUnicode');
    // 确定性
    const b = buildPdf({ ...input, font });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    // 子集字体自身可被解析器重新解析（sfnt 结构有效）
    const fontFile2 = extractFontFile2(a.bytes);
    expect(fontFile2).not.toBeNull();
    const reparsed = parseTrueTypeFont(fontFile2!);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.cmap.get('种'.codePointAt(0)!)).toBeGreaterThan(0);
    expect(reparsed!.cmap.size).toBeLessThan(font!.cmap.size * 0.3);
  }, 60000);

  it('≥30% 字符集 → 不做子集化（返回 null，整字体回退）', () => {
    if (!hasMsyh) return;
    const font = parseTrueTypeFont(new Uint8Array(readFileSync(MSYH)))!;
    const many = new Set<number>(font.cmap.keys()); // 全字符集
    expect(subsetTrueTypeFont(font, many)).toBeNull();
    // 空集也不子集化
    expect(subsetTrueTypeFont(font, new Set())).toBeNull();
  }, 60000);

  it('子集字体的 cmap 覆盖文本全部字符（可复制性基础）', () => {
    if (!hasMsyh) return;
    const font = parseTrueTypeFont(new Uint8Array(readFileSync(MSYH)))!;
    const used = new Set<number>();
    for (const ch of '种群密度标志重捕法') used.add(ch.codePointAt(0)!);
    const subset = subsetTrueTypeFont(font, used);
    expect(subset).not.toBeNull();
    for (const cp of used) {
      expect(subset!.cmap.has(cp)).toBe(true);
      const gid = subset!.cmap.get(cp)!;
      expect(subset!.widths.has(gid)).toBe(true);
    }
  }, 60000);
});

/** 从 PDF 字节里抽 FontFile2 流（测试用） */
function extractFontFile2(pdf: Uint8Array): Uint8Array | null {
  const text = Buffer.from(pdf).toString('latin1');
  const m = /(\d+) 0 obj\n<< \/Length (\d+) \/Length1 (\d+) >>\nstream\n/.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  return pdf.subarray(start, start + Number(m[2]));
}
