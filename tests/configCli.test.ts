import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, summarize } from '../cli/config.js';
import { readConfig, readApiKey } from '../adapters/core/configStore.js';

const dirs: string[] = [];
const savedEnv = process.env.NANGYING_CONFIG_DIR;
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.NANGYING_CONFIG_DIR;
  else process.env.NANGYING_CONFIG_DIR = savedEnv;
});

function useTempConfigDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'nangying-cliconfig-'));
  dirs.push(d);
  process.env.NANGYING_CONFIG_DIR = d;
  return d;
}

describe('config CLI 参数解析', () => {
  it('parseArgs 覆盖全部参数', () => {
    const args = parseArgs([
      '--provider', 'kimi', '--model', 'm1', '--endpoint', 'https://e.example',
      '--api-key', 'test-key-xxx', '--show',
    ]);
    expect(args).toEqual({
      provider: 'kimi', model: 'm1', endpoint: 'https://e.example',
      apiKey: 'test-key-xxx', show: true,
    });
    expect(parseArgs(['--api-key-env', 'MY_ENV', '--clear'])).toEqual({
      apiKeyEnv: 'MY_ENV', clear: true,
    });
  });
});

describe('config CLI 参数模式（经 spawn 实测 dist 冒烟另见报告）', () => {
  it('summarize 脱敏：含 provider/model/路径，不含 key 明文', async () => {
    useTempConfigDir();
    const { writeConfig, writeApiKey } = await import('../adapters/core/configStore.js');
    writeConfig({ provider: 'openai', model: 'gpt-4o' });
    writeApiKey('test-key-xxx');
    const out = summarize();
    expect(out).toContain('openai');
    expect(out).toContain('gpt-4o');
    expect(out).toContain('已配置（不显示明文）');
    expect(out).not.toContain('test-key-xxx');
    expect(readConfig()!.provider).toBe('openai');
    expect(readApiKey()).toBe('test-key-xxx');
  });
});
