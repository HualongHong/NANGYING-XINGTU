/**
 * CI/本地通用：准备 OCR 语言包（跨平台，替代 curl + sha256sum 的 bash 写法）。
 * 已存在且 sha256 匹配则跳过；下载后校验，不匹配即失败（防篡改/防截断）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/';
const FILES = [
  ['chi_sim.traineddata', 'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730'],
  ['eng.traineddata', '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'],
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(join(root, 'tessdata'), { recursive: true });
for (const [name, expected] of FILES) {
  const p = join(root, 'tessdata', name);
  if (existsSync(p) && sha256(readFileSync(p)) === expected) {
    console.log(`tessdata/${name} 已存在且哈希匹配，跳过`);
    continue;
  }
  console.log(`下载 tessdata/${name} …`);
  const resp = await fetch(BASE + name);
  if (!resp.ok) {
    console.error(`下载 tessdata/${name} 失败：HTTP ${resp.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (sha256(buf) !== expected) {
    console.error(`tessdata/${name} sha256 校验失败（疑似截断或篡改），已拒绝写入`);
    process.exit(1);
  }
  writeFileSync(p, buf);
  console.log(`tessdata/${name} 就绪（sha256 校验通过，${(buf.length / 1048576).toFixed(1)} MB）`);
}
