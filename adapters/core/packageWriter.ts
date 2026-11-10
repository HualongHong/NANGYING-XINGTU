/**
 * 课程包写入（适配层，允许 Node API）。
 * 零新依赖：用 Node Buffer 拼 ZIP 存储格式（不压缩），CRC32 自制表实现；
 * 时间戳固定为 1980-01-01（ZIP 纪元），保证产物确定性。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PackageContentModel } from '../../core/course/exportCoursePackage.js';

// ---------- CRC32 ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- ZIP（stored，无压缩） ----------

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = 0x21; // 1980-01-01

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/**
 * 序列化内容为最小 ZIP（stored）字节。
 * 结构：local file headers + central directory + end of central directory。
 */
export function toZipBuffer(model: PackageContentModel): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of model.files) {
    const nameBuf = Buffer.from(file.path, 'utf8');
    const dataBuf = Buffer.from(file.content, 'utf8');
    const crc = crc32(dataBuf);

    localParts.push(
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: stored
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(dataBuf.length), // compressed size
      u32(dataBuf.length), // uncompressed size
      u16(nameBuf.length),
      u16(0), // extra len
      nameBuf,
      dataBuf,
    );

    centralParts.push(
      u32(0x02014b50), // central directory signature
      u16(20), // version made by
      u16(20), // version needed
      u16(0),
      u16(0),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(dataBuf.length),
      u32(dataBuf.length),
      u16(nameBuf.length),
      u16(0), // extra len
      u16(0), // comment len
      u16(0), // disk number
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(offset), // local header offset
      nameBuf,
    );

    offset += 30 + nameBuf.length + dataBuf.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), // disk number
    u16(0), // central dir start disk
    u16(model.files.length), // entries on this disk
    u16(model.files.length), // total entries
    u32(centralBuf.length),
    u32(offset), // central dir offset
    u16(0), // comment len
  ]);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/** 写 ZIP 文件到磁盘（自动创建目录） */
export function writePackageZip(model: PackageContentModel, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, toZipBuffer(model));
}

/** 目录形式输出：按包内路径写文件（自动创建子目录） */
export function writePackageDir(model: PackageContentModel, outDir: string): void {
  for (const file of model.files) {
    const full = join(outDir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content, 'utf8');
  }
}
