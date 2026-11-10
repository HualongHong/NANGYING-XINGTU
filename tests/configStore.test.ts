import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeConfig,
  readConfig,
  writeApiKey,
  readApiKey,
  clearApiKey,
  settingsPath,
  secretsPath,
} from '../adapters/core/configStore.js';

const dirs: string[] = [];
const savedEnv = process.env.NANGYING_CONFIG_DIR;
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.NANGYING_CONFIG_DIR;
  else process.env.NANGYING_CONFIG_DIR = savedEnv;
});

function useTempConfigDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'nangying-config-'));
  dirs.push(d);
  process.env.NANGYING_CONFIG_DIR = d;
  return d;
}

describe('configStore（配置与密钥分离存放）', () => {
  it('settings 写读往返，且与 secrets 物理分离', () => {
    useTempConfigDir();
    writeConfig({ provider: 'kimi', model: 'moonshot-v1-8k', endpoint: 'https://api.moonshot.cn' });
    expect(readConfig()).toEqual({
      provider: 'kimi',
      model: 'moonshot-v1-8k',
      endpoint: 'https://api.moonshot.cn',
    });
    // 分离：settings 不含 apiKey 字段
    const settings = readFileSync(settingsPath(), 'utf8');
    expect(settings).not.toContain('apiKey');
    expect(existsSync(secretsPath())).toBe(false);
  });

  it('含 key/token/secret/password 字段的 config 被拒写', () => {
    useTempConfigDir();
    expect(() =>
      writeConfig({ provider: 'kimi', apiKey: 'test-key-xxx' } as never),
    ).toThrow('疑似敏感信息');
    expect(() =>
      writeConfig({ provider: 'kimi', ACCESS_TOKEN: 'test-key-xxx' } as never),
    ).toThrow('疑似敏感信息');
    expect(() => readConfig()).not.toThrow();
    expect(readConfig()).toBeUndefined();
  });

  it('secrets 写入/读取/清除；缺失返回 undefined 不抛错', () => {
    useTempConfigDir();
    expect(readApiKey()).toBeUndefined();
    writeApiKey('test-key-xxx');
    expect(readApiKey()).toBe('test-key-xxx');
    // secrets 独立文件，settings 仍未创建
    expect(existsSync(settingsPath())).toBe(false);
    clearApiKey();
    expect(readApiKey()).toBeUndefined();
    expect(() => writeApiKey('')).toThrow('不能为空');
  });

  it('目录解析：env 优先', () => {
    const d = useTempConfigDir();
    expect(settingsPath().startsWith(d)).toBe(true);
    expect(secretsPath().startsWith(d)).toBe(true);
  });
});
