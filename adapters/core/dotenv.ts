/**
 * 零依赖 .env 加载（适配层共享）：逐行 KEY=VALUE，跳过注释/空行/非法行，
 * 去除成对引号，不展开变量，不打印任何内容，不覆盖已存在的环境变量。
 * eval 脚本与 LocalAdapter 的 .env 回退共用本实现。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadDotEnv(filePath: string): Record<string, string> {
  const loaded: Record<string, string> = {};
  if (!existsSync(filePath)) return loaded;
  const CR = String.fromCharCode(13);
  const lines = readFileSync(filePath, 'utf8')
    .split(String.fromCharCode(10))
    .map((l) => (l.endsWith(CR) ? l.slice(0, -1) : l));
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.length >= 2 && v[v.length - 1] === q) v = v.slice(1, -1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    loaded[k] = v;
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return loaded;
}

/** 加载仓库根 .env（若存在）；返回读到的键值（不覆盖已有环境变量） */
export function loadProjectDotEnv(cwd: string = process.cwd()): Record<string, string> {
  return loadDotEnv(join(cwd, '.env'));
}
