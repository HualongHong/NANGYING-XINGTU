/**
 * JPEG EXIF 方向解析（适配层，零依赖）。
 * 扫描 JPEG 段到 APP1（Exif），解析 TIFF IFD0 的 Orientation 标签（0x0112）。
 * 本期做"检测+报告"：无图像库时旋转不可做，由调用方在 note 中声明；
 * 若安装 sharp/jimp（optional peer）可后续扩展实际旋转。
 */

/** 解析 JPEG 的 EXIF orientation（1-9）；无 EXIF 或非 JPEG 返回 undefined */
export function parseExifOrientation(jpeg: Uint8Array): number | undefined {
  const buf = Buffer.from(jpeg);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) break;
    const marker = buf[pos + 1];
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2) break;
    // APP1
    if (marker === 0xe1) {
      const seg = buf.subarray(pos + 4, pos + 2 + len);
      if (seg.subarray(0, 6).toString('ascii') !== 'Exif\0\0') {
        pos += 2 + len;
        continue;
      }
      const tiff = seg.subarray(6);
      return parseTiffOrientation(tiff);
    }
    if (marker === 0xda) break; // SOS，段扫描结束
    pos += 2 + len;
  }
  return undefined;
}

function parseTiffOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return undefined;
  const le = tiff.toString('ascii', 0, 2) === 'II';
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) return undefined;
  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return undefined;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    if (u16(entry) === 0x0112) {
      return u16(entry + 8);
    }
  }
  return undefined;
}

/** 方向是否需要旋转（5-8 为旋转类，2-4 为镜像类） */
export function orientationNeedsRotation(o: number | undefined): boolean {
  return o !== undefined && o >= 5 && o <= 8;
}
