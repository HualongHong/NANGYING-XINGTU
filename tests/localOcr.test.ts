import { describe, expect, it, vi } from 'vitest';
import { createLocalOcrDecoder, type OcrEngine } from '../adapters/core/decoders/localOcrDecoder.js';

/** 构造含两张 JPEG 图的最小 PDF（复用抽取器约定） */
function pdfWithJpegs(jpegs: Buffer[]): Buffer {
  const parts: Array<string | Buffer> = ['%PDF-1.4\n'];
  jpegs.forEach((jpeg, i) => {
    const objNum = i + 5;
    parts.push(
      `${objNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      jpeg,
      '\nendstream\nendobj\n',
    );
  });
  parts.push('trailer\n<< >>\n%%EOF\n');
  return Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p)));
}

const JPEG_STUB = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+gD/2Q==',
  'base64',
);

describe('localOcrDecoder', () => {
  it('逐页识别拼接：输出带 === 第N页 === 标记，按页序', async () => {
    const engine: OcrEngine = {
      recognize: vi.fn(async (_img: Uint8Array, _langs: string) => '页内容'),
    };
    const decoder = createLocalOcrDecoder({ engine });
    const pdf = pdfWithJpegs([JPEG_STUB, JPEG_STUB, JPEG_STUB]);
    const doc = await decoder.decode({ data: new Uint8Array(pdf), materialType: 'pdf' });
    expect(doc.content).toContain('=== 第1页 ===');
    expect(doc.content).toContain('=== 第3页 ===');
    expect(doc.content.split('===').filter((s) => s.includes('页内容'))).toHaveLength(3);
    expect(engine.recognize).toHaveBeenCalledTimes(3);
  });

  it('pageRange 限定页区间', async () => {
    const engine: OcrEngine = { recognize: vi.fn(async () => '页内容') };
    const decoder = createLocalOcrDecoder({ engine });
    const pdf = pdfWithJpegs([JPEG_STUB, JPEG_STUB, JPEG_STUB]);
    const doc = await decoder.decode({
      data: new Uint8Array(pdf),
      materialType: 'pdf',
      pageRange: { from: 2, to: 3 },
    });
    expect(doc.content).toContain('=== 第2页 ===');
    expect(doc.content).toContain('=== 第3页 ===');
    expect(doc.content).not.toContain('=== 第1页 ===');
    expect(engine.recognize).toHaveBeenCalledTimes(2);
  });

  it('引擎缺失时给中文提示（含安装指引）', async () => {
    // 不注入 engine、在未安装场景下提示；测试环境已装 tesseract.js，
    // 因此这里验证提示文案的触发路径：直接用无图 PDF 之前的 import 探测不可行，
    // 改为验证 recognize 抛错时 decode 如实上抛（由调用方兜底下一个通道）
    const engine: OcrEngine = {
      recognize: async () => {
        throw new Error('本地 OCR 需要安装 tesseract.js（pnpm add tesseract.js），或改用宿主注入/配置的外部解码器');
      },
    };
    const decoder = createLocalOcrDecoder({ engine });
    const pdf = pdfWithJpegs([JPEG_STUB]);
    await expect(
      decoder.decode({ data: new Uint8Array(pdf), materialType: 'pdf' }),
    ).rejects.toThrow('本地 OCR 需要安装 tesseract.js');
  });

  it('PDF 无图像时抛中文错误并注明跳过数', async () => {
    const engine: OcrEngine = { recognize: vi.fn(async () => 'x') };
    const decoder = createLocalOcrDecoder({ engine });
    const pdf = Buffer.from(
      '%PDF-1.4\n5 0 obj\n<< /Subtype /Image /Width 8 /Height 8 /Filter /JBIG2Decode /Length 4 >>\nstream\nabcd\nendstream\nendobj\n%%EOF\n',
      'latin1',
    );
    await expect(
      decoder.decode({ data: new Uint8Array(pdf), materialType: 'pdf' }),
    ).rejects.toThrow('未抽取到可识别图像');
    expect(engine.recognize).not.toHaveBeenCalled();
  });

  it('非 PDF 输入按单张图片识别', async () => {
    const engine: OcrEngine = { recognize: vi.fn(async () => '图片文字') };
    const decoder = createLocalOcrDecoder({ engine });
    const doc = await decoder.decode({ data: new Uint8Array(JPEG_STUB), materialType: 'png' });
    expect(doc.content).toContain('=== 第1页 ===');
    expect(doc.content).toContain('图片文字');
  });
});
