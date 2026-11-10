/** 测试共用：内存最小 PPTX（含一张图片的课件）构造 helper */
import { deflateRawSync } from 'node:zlib';

export function buildMiniZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
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

export const FAKE_IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xd9]);

/** 单页课件：1 张图片（无文本） */
export function zipWithOneImage(): Uint8Array {
  const slide = `<?xml?><p:sld xmlns:a="a" xmlns:p="p" xmlns:r="r">` +
    `<p:pic><a:blip r:embed="rId2"/></p:pic></p:sld>`;
  const rels = `<?xml?><Relationships><Relationship Id="rId2" Target="../media/image1.jpeg"/></Relationships>`;
  return new Uint8Array(buildMiniZip([
    { name: 'ppt/slides/slide1.xml', data: Buffer.from(slide) },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: Buffer.from(rels) },
    { name: 'ppt/media/image1.jpeg', data: Buffer.from(FAKE_IMAGE_BYTES) },
  ]));
}
