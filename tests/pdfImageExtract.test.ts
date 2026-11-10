import { describe, expect, it } from 'vitest';
import { extractPdfImages, encodePng } from '../adapters/core/decoders/pdfImageExtract.js';
import { inflateSync } from 'node:zlib';

/** 8x8 红色 JPEG（base64 内嵌，最小合成测试图） */
const JPEG_8X8_B64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
  'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
  'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
  'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB' +
  'AAIRAxEAPwD3+gD/2Q==';

function jpegBytes(): Buffer {
  return Buffer.from(JPEG_8X8_B64, 'base64');
}

/** 合成最小 PDF：内嵌一张 DCTDecode 图像对象 */
function syntheticPdfWithJpeg(jpeg: Buffer): Buffer {
  const obj = [
    '5 0 obj',
    '<< /Type /XObject /Subtype /Image /Width 8 /Height 8',
    '   /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>',
    'stream',
  ].join('\n');
  const parts = [
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>\nendobj\n',
    obj + '\n',
    jpeg,
    '\nendstream\nendobj\n',
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
  ];
  return Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p)));
}

describe('pdfImageExtract', () => {
  it('encodePng 产出合法 PNG 结构（签名 + IHDR + IEND）', () => {
    const raw = new Uint8Array(4 * 4 * 3).fill(200);
    const png = encodePng(4, 4, 2, raw);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.includes(Buffer.from('IHDR'))).toBe(true);
    expect(png.includes(Buffer.from('IEND'))).toBe(true);
    // IDAT 可 inflate 回扫描线（每行 1+4*3 字节）
    const idatStart = png.indexOf(Buffer.from('IDAT')) + 4;
    const idatLen = png.readUInt32BE(idatStart - 8);
    const raw2 = inflateSync(png.subarray(idatStart, idatStart + idatLen));
    expect(raw2.length).toBe((4 * 3 + 1) * 4);
  });

  it('合成 PDF：抽取 DCTDecode 图像，JPEG 字节原样取出', () => {
    const jpeg = jpegBytes();
    const pdf = syntheticPdfWithJpeg(jpeg);
    const { images, skipped } = extractPdfImages(new Uint8Array(pdf));
    expect(skipped).toBe(0);
    expect(images).toHaveLength(1);
    expect(images[0].format).toBe('jpeg');
    expect(Buffer.from(images[0].data).equals(jpeg)).toBe(true);
  });

  it('不含图像的 PDF 返回空列表', () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n', 'latin1');
    const { images, skipped } = extractPdfImages(new Uint8Array(pdf));
    expect(images).toHaveLength(0);
    expect(skipped).toBe(0);
  });

  it('不支持的 Filter 被跳过并计数', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n' +
        '5 0 obj\n<< /Subtype /Image /Width 8 /Height 8 /Filter /JBIG2Decode /Length 10 >>\n' +
        'stream\n0123456789\nendstream\nendobj\n%%EOF\n',
      'latin1',
    );
    const { images, skipped } = extractPdfImages(new Uint8Array(pdf));
    expect(images).toHaveLength(0);
    expect(skipped).toBe(1);
  });
});
