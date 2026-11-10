/**
 * 解码缓存（适配层）：内容 SHA-256 → 解码文本。
 * 目录：~/.nangying-starmap/cache/decode/（configStore 路径约定，env 可覆盖）。
 * 键含 materialType + pageRange + 解码器版本号，引擎升级后自动失效。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../configStore.js';

export const DECODER_VERSION = 'v1';

export function decodeCacheDir(): string {
  return join(configDir(), 'cache', 'decode');
}

export function decodeCacheKey(
  data: Uint8Array,
  materialType: string,
  pageRange?: { from: number; to: number },
): string {
  const contentHash = createHash('sha256').update(Buffer.from(data)).digest('hex');
  const range = pageRange ? `${pageRange.from}-${pageRange.to}` : 'all';
  return `${materialType}-${range}-${DECODER_VERSION}-${contentHash}`;
}

export function readDecodeCache(key: string): string | undefined {
  const file = join(decodeCacheDir(), `${key}.txt`);
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8');
}

export function writeDecodeCache(key: string, text: string): void {
  mkdirSync(decodeCacheDir(), { recursive: true });
  writeFileSync(join(decodeCacheDir(), `${key}.txt`), text, 'utf8');
}

export function clearDecodeCache(): void {
  // 留空实现由调用方按需扩展（递归删除目录）；本期仅提供单键读写
}
