/**
 * 写出路径护栏（适配层）。
 *
 * 教师场景需要写到任意工作区，故不做 workspaceRoot 限制；
 * 只挡明显危险目标，防"模型/用户误给输出路径"造成不可逆破坏：
 *  - 配置目录整体（secrets.json / jobs / kb / cache 全在里面；内部写盘不经过本护栏）；
 *  - SSH/GPG/AWS 凭证目录；
 *  - 系统目录（Unix：/etc /usr /bin /sbin /boot /proc /sys /dev；Windows：%WINDIR%、Program Files）。
 * 比较前统一 resolve 规范化；win32 下大小写不敏感。
 */
import { resolve, sep } from 'node:path';
import { homedir, platform } from 'node:os';
import { configDir } from './configStore.js';

function normalizeForCompare(p: string): string {
  const r = resolve(p);
  return platform() === 'win32' ? r.toLowerCase() : r;
}

function forbiddenDirs(): string[] {
  const home = homedir();
  const dirs = [
    configDir(),
    join2(home, '.ssh'),
    join2(home, '.gnupg'),
    join2(home, '.aws'),
  ];
  if (platform() === 'win32') {
    dirs.push(
      process.env.WINDIR ?? 'C:\\Windows',
      process.env['ProgramFiles'] ?? 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    );
  } else {
    dirs.push('/etc', '/usr', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev');
  }
  return dirs.map(normalizeForCompare);
}

function join2(a: string, b: string): string {
  return a.endsWith(sep) ? a + b : a + sep + b;
}

function isInside(target: string, dir: string): boolean {
  return target === dir || target.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * 校验目标路径可写；返回规范化绝对路径。
 * 命中禁区抛 Error（message 中文，含目标路径，供执行器转结构化错误）。
 */
export function assertWritablePath(target: string): string {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error('输出路径不能为空');
  }
  if (target.includes('\0')) {
    throw new Error('输出路径含非法 NUL 字符');
  }
  const abs = resolve(target);
  const cmp = normalizeForCompare(abs);
  for (const dir of forbiddenDirs()) {
    if (isInside(cmp, dir)) {
      throw new Error(`输出路径位于受保护目录内，已拒绝写入：${abs}（禁区：${dir}）`);
    }
  }
  return abs;
}

/**
 * 校验 dir 形式导出的包内相对路径不逃逸出 outDir（zip-slip 防护）。
 * 返回拼接后的绝对路径；逃逸即抛错。
 */
export function assertPackageInnerPath(outDir: string, innerPath: string): string {
  const base = resolve(outDir);
  const full = resolve(base, innerPath);
  const cmpBase = normalizeForCompare(base);
  const cmpFull = normalizeForCompare(full);
  if (!isInside(cmpFull, cmpBase)) {
    throw new Error(`包内路径逃逸输出目录，已拒绝：${innerPath} → ${full}`);
  }
  return full;
}
