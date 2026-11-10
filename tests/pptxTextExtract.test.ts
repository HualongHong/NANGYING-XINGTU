import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
  readZipEntries,
  listZipEntries,
  extractAText,
  extractPptxText,
  toPagedText,
} from '../adapters/core/decoders/pptxTextExtract.js';

/** 内存 zip 打包 helper（stored 或 deflate），与真实 PPTX 同结构 */
function buildZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.deflate ? deflateRawSync(e.data) : e.data;
    const method = e.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([local, nameBuf, data]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    offset += 30 + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function slideXml(texts: string[]): string {
  const runs = texts
    .map((t) => `<a:r><a:t>${t}</a:t></a:r>`)
    .join('');
  return `<?xml version="1.0"?><p:sld xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree><p:sp><p:txBody>${runs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

describe('pptxTextExtract', () => {
  it('readZipEntries：stored 与 deflate 混合，按名定位', () => {
    const zip = buildZip([
      { name: 'a.txt', data: Buffer.from('hello', 'utf8') },
      { name: 'b/c.txt', data: Buffer.from('世界', 'utf8'), deflate: true },
    ]);
    const got = readZipEntries(new Uint8Array(zip), new Set(['a.txt', 'b/c.txt']));
    expect(got.get('a.txt')!.toString('utf8')).toBe('hello');
    expect(got.get('b/c.txt')!.toString('utf8')).toBe('世界');
  });

  it('listZipEntries：数字自然序（slide2 在 slide10 前）', () => {
    const zip = buildZip([
      { name: 'ppt/slides/slide10.xml', data: Buffer.from('x') },
      { name: 'ppt/slides/slide2.xml', data: Buffer.from('x') },
      { name: 'ppt/slides/slide1.xml', data: Buffer.from('x') },
    ]);
    const names = listZipEntries(new Uint8Array(zip), /^ppt\/slides\/slide\d+\.xml$/);
    expect(names).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide10.xml']);
  });

  it('extractAText：按 XML 顺序提取、解码实体、跳过空节点', () => {
    const xml = '<a:t>第一段</a:t><a:t></a:t><a:t>&lt;标记&gt; &amp; &quot;引号&quot;</a:t><a:t>第二段</a:t>';
    expect(extractAText(xml)).toEqual(['第一段', '<标记> & "引号"', '第二段']);
  });

  it('多幻灯片：顺序、空幻灯片、备注挂载', () => {
    const zip = buildZip([
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(slideXml(['实验目的', '掌握离心技术']), 'utf8'), deflate: true },
      { name: 'ppt/slides/slide2.xml', data: Buffer.from(slideXml([]), 'utf8') },
      { name: 'ppt/slides/slide3.xml', data: Buffer.from(slideXml(['比色法测定']), 'utf8') },
      { name: 'ppt/notesSlides/notesSlide1.xml', data: Buffer.from(slideXml(['强调安全操作']), 'utf8') },
      { name: 'ppt/notesSlides/notesSlide3.xml', data: Buffer.from(slideXml(['补充公式推导']), 'utf8') },
    ]);
    const result = extractPptxText(new Uint8Array(zip));
    expect(result.slides).toHaveLength(3);
    expect(result.slides[0].texts).toEqual(['实验目的', '掌握离心技术']);
    expect(result.slides[0].notes).toEqual(['强调安全操作']);
    expect(result.slides[1].texts).toEqual([]);
    expect(result.slides[2].notes).toEqual(['补充公式推导']);
    expect(result.imageOnlySlides).toBe(1);
  });

  it('toPagedText：=== 第N页 === 形态与 PDF 解码器一致，要点空行分隔、含备注标注', () => {
    const zip = buildZip([
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(slideXml(['标题', '正文']), 'utf8') },
      { name: 'ppt/notesSlides/notesSlide1.xml', data: Buffer.from(slideXml(['备注内容']), 'utf8') },
    ]);
    const text = toPagedText(extractPptxText(new Uint8Array(zip)));
    expect(text).toContain('=== 第1页 ===\n标题\n\n正文\n[备注] 备注内容');
  });

  it('非法 zip 抛中文错误', () => {
    expect(() => extractPptxText(new Uint8Array(Buffer.from('not a zip')))).toThrow('EOCD');
  });
});
