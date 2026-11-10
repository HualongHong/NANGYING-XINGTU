/**
 * 最小化 PDF 页图抽取（适配层，零依赖）。
 *
 * 不做完整 xref 解析：直接扫描字节流定位 stream…endstream，
 * 依据对象字典判定 /Subtype /Image：
 *  - /DCTDecode：JPEG 原样取出；
 *  - /FlateDecode：zlib.inflate 后按 /Width /Height /ColorSpace
 *    （仅 DeviceRGB/DeviceGray、8bit、无预测）组装最小 PNG，复杂情况跳过并计数。
 *
 * 图像顺序 = 流出现顺序（近似页序，已满足逐页 OCR 的需求）；不保证覆盖所有 PDF 变体。
 */
import { inflateSync, deflateSync } from 'node:zlib';
import { crc32 } from '../packageWriter.js';

export interface ExtractedImage {
  data: Uint8Array;
  format: 'jpeg' | 'png';
  width?: number;
  height?: number;
}

export interface PdfExtractResult {
  images: ExtractedImage[];
  skipped: number;
}

/** 最小 PNG 编码器（8bit，colorType 0=Gray / 2=RGB，filter 0） */
export function encodePng(
  width: number,
  height: number,
  colorType: 0 | 2,
  raw: Uint8Array,
): Buffer {
  const channels = colorType === 2 ? 3 : 1;
  const stride = width * channels;
  // 每行前置 filter 字节 0
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    scanlines[y * (stride + 1)] = 0;
    scanlines.set(raw.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(scanlines);

  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function findImagesInStreamDict(dict: string): {
  subtype: string | null;
  filter: string | null;
  width: number;
  height: number;
  colorSpace: string | null;
  bits: number;
  length: number;
} {
  const grab = (key: string): string | null => {
    const m = new RegExp(`/${key}\\s+(/?[A-Za-z0-9]+)`).exec(dict);
    return m ? m[1].replace(/^\//, '') : null;
  };
  return {
    subtype: grab('Subtype'),
    filter: grab('Filter'),
    width: Number(grab('Width') ?? 0),
    height: Number(grab('Height') ?? 0),
    colorSpace: grab('ColorSpace'),
    bits: Number(grab('BitsPerComponent') ?? 8),
    length: Number(grab('Length') ?? 0),
  };
}

/** 扫描 PDF 字节流，抽取内嵌图像（JPEG 原样 / Flate 组 PNG） */
export function extractPdfImages(pdf: Uint8Array): PdfExtractResult {
  const images: ExtractedImage[] = [];
  let skipped = 0;
  const bytes = Buffer.from(pdf);
  const STREAM = Buffer.from('stream');
  const ENDSTREAM = Buffer.from('endstream');

  let pos = 0;
  while (pos < bytes.length) {
    const sIdx = bytes.indexOf(STREAM, pos);
    if (sIdx < 0) break;
    const dataStart = sIdx + STREAM.length +
      (bytes[sIdx + STREAM.length] === 0x0d && bytes[sIdx + STREAM.length + 1] === 0x0a ? 2
        : bytes[sIdx + STREAM.length] === 0x0a ? 1 : 0);
    const eIdx = bytes.indexOf(ENDSTREAM, dataStart);
    if (eIdx < 0) break;
    // 对象字典：向前找最近的 "obj"
    const objIdx = bytes.lastIndexOf(Buffer.from('obj'), sIdx);
    const dict = bytes.subarray(Math.max(0, objIdx), sIdx).toString('latin1');
    const info = findImagesInStreamDict(dict);
    // 优先按 /Length 精确取流数据；缺失时退到 endstream 并剥掉尾部换行
    let data: Buffer;
    if (info.length > 0 && dataStart + info.length <= eIdx) {
      data = bytes.subarray(dataStart, dataStart + info.length);
    } else {
      data = bytes.subarray(dataStart, eIdx);
      if (data[data.length - 1] === 0x0a) data = data.subarray(0, data.length - 1);
      if (data[data.length - 1] === 0x0d) data = data.subarray(0, data.length - 1);
    }

    if (info.subtype === 'Image') {
      if (info.filter === 'DCTDecode') {
        images.push({ data: new Uint8Array(data), format: 'jpeg' });
      } else if (info.filter === 'FlateDecode' && info.width > 0 && info.height > 0 &&
                 info.bits === 8 &&
                 (info.colorSpace === 'DeviceRGB' || info.colorSpace === 'DeviceGray')) {
        try {
          const raw = inflateSync(data);
          const channels = info.colorSpace === 'DeviceRGB' ? 3 : 1;
          if (raw.length >= info.width * info.height * channels) {
            images.push({
              data: new Uint8Array(encodePng(
                info.width, info.height,
                info.colorSpace === 'DeviceRGB' ? 2 : 0,
                raw.subarray(0, info.width * info.height * channels),
              )),
              format: 'png',
              width: info.width,
              height: info.height,
            });
          } else {
            skipped += 1;
          }
        } catch {
          skipped += 1;
        }
      } else {
        skipped += 1;
      }
    }
    pos = eIdx + ENDSTREAM.length;
  }
  return { images, skipped };
}
