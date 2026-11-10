import { describe, expect, it, vi } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { extractPptxImages } from '../adapters/core/decoders/pptxTextExtract.js';
import { createLocalOcrDecoder, type OcrEngine } from '../adapters/core/decoders/localOcrDecoder.js';
import { parseExifOrientation, orientationNeedsRotation } from '../adapters/core/decoders/exifOrientation.js';

function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const isText = e.name.endsWith('.xml') || e.name.endsWith('.rels');
    const data = isText ? deflateRawSync(e.data) : e.data;
    const method = isText ? 8 : 0;
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

const FAKE_IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

describe('PPTX 图片 OCR（r:embed 顺序）', () => {
  function pptxWithImages(): Buffer {
    const slide1 = `<?xml?><p:sld xmlns:a="a" xmlns:p="p" xmlns:r="r">` +
      `<p:pic><a:blip r:embed="rId2"/></p:pic></p:sld>`;
    const slide2 = `<?xml?><p:sld xmlns:a="a" xmlns:p="p" xmlns:r="r">` +
      `<p:sp><p:txBody><a:r><a:t>第二页标题</a:t></a:r></p:txBody></p:sp>` +
      `<p:pic><a:blip r:embed="rId3"/></p:pic></p:spTree></p:sld>`;
    const rels1 = `<?xml?><Relationships>` +
      `<Relationship Id="rId2" Target="../media/image1.png"/></Relationships>`;
    const rels2 = `<?xml?><Relationships>` +
      `<Relationship Id="rId3" Target="../media/image2.png"/></Relationships>`;
    return buildZip([
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(slide1) },
      { name: 'ppt/slides/slide2.xml', data: Buffer.from(slide2) },
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: Buffer.from(rels1) },
      { name: 'ppt/slides/_rels/slide2.xml.rels', data: Buffer.from(rels2) },
      { name: 'ppt/media/image1.png', data: FAKE_IMAGE },
      { name: 'ppt/media/image2.png', data: FAKE_IMAGE },
    ]);
  }

  it('extractPptxImages：按幻灯片与引用顺序输出', () => {
    const { images, skippedNonRaster } = extractPptxImages(new Uint8Array(pptxWithImages()));
    expect(images.map((x) => [x.page, x.index, x.name])).toEqual([
      [1, 1, 'ppt/media/image1.png'],
      [2, 1, 'ppt/media/image2.png'],
    ]);
    expect(skippedNonRaster).toBe(0);
  });

  it('纯图片课件：mock 引擎逐页 OCR，输出 [图k] 与页标记', async () => {
    const recognize = vi.fn(async (img: Uint8Array) =>
      img.length === FAKE_IMAGE.length ? '图片文字' : '?',
    );
    const engine: OcrEngine = { recognize };
    const decoder = createLocalOcrDecoder({ engine });
    const doc = await decoder.decode({
      data: new Uint8Array(pptxWithImages()),
      materialType: 'pptx',
    });
    expect(doc.content).toContain('=== 第1页 ===');
    expect(doc.content).toContain('[图1] 图片文字');
    expect(doc.content).toContain('第二页标题');
    expect(doc.note).toContain('图片 OCR');
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it('图文混合：文本优先，OCR 附后；无图课件不加载引擎', async () => {
    const textOnly = buildZip([
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(
        '<p:sld><p:sp><p:txBody><a:r><a:t>只有文本</a:t></a:r></p:txBody></p:sp></p:sld>') },
    ]);
    const recognize = vi.fn(async () => 'x');
    const decoder = createLocalOcrDecoder({ engine: { recognize } });
    const doc = await decoder.decode({ data: new Uint8Array(textOnly), materialType: 'pptx' });
    expect(doc.content).toContain('只有文本');
    expect(doc.note).toContain('PPTX 原生文本');
    expect(recognize).not.toHaveBeenCalled();
  });
});

describe('EXIF 方向解析', () => {
  /** 构造带 EXIF orientation 的最小 JPEG */
  function jpegWithOrientation(o: number): Buffer {
    // TIFF：II, 42, IFD0@8, 1 个条目 (0x0112, SHORT, count1, value=o)
    const tiff = Buffer.alloc(26);
    tiff.write('II', 0, 'ascii');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8); // entry count
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12); // SHORT
    tiff.writeUInt32LE(1, 14); // count
    tiff.writeUInt16LE(o, 18); // value
    tiff.writeUInt32LE(0, 22); // next IFD
    const exifPayload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const app1Len = exifPayload.length + 2;
    const app1 = Buffer.concat([
      Buffer.from([0xff, 0xe1, app1Len >> 8, app1Len & 0xff]),
      exifPayload,
    ]);
    return Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      app1,
      Buffer.from([0xff, 0xda, 0, 8, 1, 2, 3]),
    ]);
  }

  it('解析 orientation=6（需旋转）', () => {
    expect(parseExifOrientation(jpegWithOrientation(6))).toBe(6);
    expect(orientationNeedsRotation(6)).toBe(true);
  });

  it('orientation=1 与无 EXIF', () => {
    expect(parseExifOrientation(jpegWithOrientation(1))).toBe(1);
    expect(orientationNeedsRotation(1)).toBe(false);
    expect(parseExifOrientation(new Uint8Array([0xff, 0xd8, 1, 2]))).toBeUndefined();
    expect(parseExifOrientation(new Uint8Array(Buffer.from('not jpeg')))).toBeUndefined();
  });
});

describe('非光栅媒体跳过', () => {
  it('emf/wmf/mp4 不计入图片列表并计数', async () => {
    const { buildMiniZip } = await import('./helpers/miniPptx.js');
    const slide = '<?xml?><p:sld xmlns:r="r"><p:pic><a:blip r:embed="rId2"/></p:pic><p:pic><a:blip r:embed="rId3"/></p:pic></p:sld>';
    const rels = '<?xml?><Relationships>' +
      '<Relationship Id="rId2" Target="../media/vector.emf"/>' +
      '<Relationship Id="rId3" Target="../media/pic.png"/></Relationships>';
    const zip = buildMiniZip([
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(slide) },
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: Buffer.from(rels) },
      { name: 'ppt/media/vector.emf', data: Buffer.from([1, 2, 3]) },
      { name: 'ppt/media/pic.png', data: Buffer.from([0x89, 0x50]) },
    ]);
    const { images, skippedNonRaster } = extractPptxImages(new Uint8Array(zip));
    expect(images).toHaveLength(1);
    expect(images[0].name).toBe('ppt/media/pic.png');
    expect(skippedNonRaster).toBe(1);
  });
});
