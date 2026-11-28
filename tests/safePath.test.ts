import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { assertWritablePath, assertPackageInnerPath } from '../adapters/core/safePath.js';

let tmp: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'safepath-'));
  savedConfigDir = process.env.NANGYING_CONFIG_DIR;
  process.env.NANGYING_CONFIG_DIR = join(tmp, 'cfg');
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.NANGYING_CONFIG_DIR;
  else process.env.NANGYING_CONFIG_DIR = savedConfigDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe('assertWritablePath 写出护栏', () => {
  it('放行普通工作区路径并返回规范化绝对路径', () => {
    const target = join(tmp, 'out', 'handout.pdf');
    expect(assertWritablePath(target)).toBe(resolve(target));
  });

  it('拒绝写入配置目录（secrets/jobs/kb 所在）', () => {
    expect(() => assertWritablePath(join(tmp, 'cfg', 'secrets.json'))).toThrow(/受保护目录/);
    expect(() => assertWritablePath(join(tmp, 'cfg', 'kb', 'x.json'))).toThrow(/受保护目录/);
  });

  it('拒绝写入 SSH/GPG/AWS 凭证目录', () => {
    expect(() => assertWritablePath(join(homedir(), '.ssh', 'authorized_keys'))).toThrow(/受保护目录/);
    expect(() => assertWritablePath(join(homedir(), '.aws', 'credentials'))).toThrow(/受保护目录/);
  });

  it('拒绝相对路径逃逸进禁区（resolve 后判定）', () => {
    const sneaky = join(tmp, 'out', '..', '..', 'cfg', 'secrets.json');
    // tmp/out/../../cfg 解析后不在 tmp/cfg（在 tmp 上一级），用相对 configDir 的构造验证 resolve 语义
    const rel = join('..', '..', 'cfg', 'secrets.json');
    expect(() => assertWritablePath(resolve(join(tmp, 'cfg', 'x'), rel))).toThrow(/受保护目录/);
    expect(assertWritablePath(sneaky)).toBe(resolve(sneaky)); // 未进禁区则放行
  });

  it('拒绝空路径与 NUL 字符', () => {
    expect(() => assertWritablePath('')).toThrow(/不能为空/);
    expect(() => assertWritablePath('a\0b')).toThrow(/NUL/);
  });

  it.runIf(platform() !== 'win32')('Unix：拒绝 /etc、/usr 等系统目录', () => {
    expect(() => assertWritablePath('/etc/cron.d/x')).toThrow(/受保护目录/);
    expect(() => assertWritablePath('/usr/local/bin/x')).toThrow(/受保护目录/);
  });

  it.runIf(platform() === 'win32')('Windows：拒绝 %WINDIR% 与 Program Files（大小写不敏感）', () => {
    expect(() => assertWritablePath('c:\\windows\\system32\\x.dll')).toThrow(/受保护目录/);
    expect(() => assertWritablePath('C:\\Program Files\\x\\y.exe')).toThrow(/受保护目录/);
  });
});

describe('assertPackageInnerPath zip-slip 防护', () => {
  it('放行正常包内路径', () => {
    const full = assertPackageInnerPath(tmp, join('handout', 'a.docx'));
    expect(full).toBe(resolve(tmp, 'handout', 'a.docx'));
  });

  it('拒绝 ../ 逃逸输出目录', () => {
    expect(() => assertPackageInnerPath(tmp, '../evil.txt')).toThrow(/逃逸/);
    expect(() => assertPackageInnerPath(tmp, join('handout', '..', '..', 'evil.txt'))).toThrow(/逃逸/);
  });

  it('拒绝绝对路径包内项', () => {
    const abs = platform() === 'win32' ? 'C:\\Windows\\x.txt' : '/etc/x.txt';
    expect(() => assertPackageInnerPath(tmp, abs)).toThrow(/逃逸/);
  });

  it('边界：与 outDir 同前缀的兄弟目录也算逃逸', () => {
    const sibling = `${tmp}-evil${sep}x.txt`;
    expect(() => assertPackageInnerPath(tmp, sibling)).toThrow(/逃逸/);
  });
});
