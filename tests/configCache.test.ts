import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeConfig, readConfig, writeApiKey, readApiKey, clearApiKey,
  settingsPath, secretsPath,
} from '../adapters/core/configStore.js';
import { withLlmCache, llmCacheDir } from '../adapters/core/llmCache.js';
import { createLlmFromEnv } from '../adapters/core/llmFromEnv.js';
import type { LLMProvider } from '../core/llm.js';

let tmp: string;
let savedConfigDir: string | undefined;
let savedLlmCache: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cfgcache-'));
  savedConfigDir = process.env.NANGYING_CONFIG_DIR;
  process.env.NANGYING_CONFIG_DIR = join(tmp, 'cfg');
  savedLlmCache = process.env.NANGYING_LLM_CACHE;
  delete process.env.NANGYING_LLM_CACHE;
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.NANGYING_CONFIG_DIR;
  else process.env.NANGYING_CONFIG_DIR = savedConfigDir;
  if (savedLlmCache === undefined) delete process.env.NANGYING_LLM_CACHE;
  else process.env.NANGYING_LLM_CACHE = savedLlmCache;
  rmSync(tmp, { recursive: true, force: true });
});

describe('configStore 读缓存（B1）', () => {
  it('写后读一致；连续两次写读到最新值', () => {
    writeConfig({ provider: 'deepseek', model: 'm1' });
    expect(readConfig()?.model).toBe('m1');
    writeConfig({ provider: 'deepseek', model: 'm2' });
    expect(readConfig()?.model).toBe('m2');
  });

  it('外部直接改文件（mtime/size 变化）后读到新值', () => {
    writeConfig({ provider: 'deepseek', model: 'm1' });
    expect(readConfig()?.model).toBe('m1');
    // 模拟用户手工编辑 settings.json
    writeFileSync(settingsPath(), JSON.stringify({ provider: 'kimi', model: 'moonshot-v1-8k' }), 'utf8');
    expect(readConfig()?.provider).toBe('kimi');
  });

  it('secrets 写/清后读一致', () => {
    writeApiKey('sk-b1-test-123456', 'mineruApiKey');
    expect(readApiKey('mineruApiKey')).toBe('sk-b1-test-123456');
    writeApiKey('sk-b1-test-654321', 'mineruApiKey');
    expect(readApiKey('mineruApiKey')).toBe('sk-b1-test-654321');
    clearApiKey('mineruApiKey');
    expect(readApiKey('mineruApiKey')).toBeUndefined();
    expect(readFileSync(secretsPath(), 'utf8')).not.toContain('sk-b1-test');
  });
});

describe('llmCache 响应缓存（B2，opt-in）', () => {
  function countingProvider(response = '答案'): { provider: LLMProvider; calls: () => number } {
    let n = 0;
    return {
      provider: { complete: async () => { n += 1; return response; } },
      calls: () => n,
    };
  }

  it('同 prompt 第二次命中缓存，不再真实调用', async () => {
    const { provider, calls } = countingProvider();
    const cached = withLlmCache(provider, 'test|m|e');
    expect(await cached.complete('术语判定：光合作用')).toBe('答案');
    expect(await cached.complete('术语判定：光合作用')).toBe('答案');
    expect(calls()).toBe(1);
    expect(await cached.complete('术语判定：呼吸作用')).toBe('答案');
    expect(calls()).toBe(2);
  });

  it('tag 不同（换模型/端点）缓存隔离', async () => {
    const { provider, calls } = countingProvider();
    await withLlmCache(provider, 'deepseek|m1|e1').complete('同一 prompt');
    await withLlmCache(provider, 'kimi|m2|e2').complete('同一 prompt');
    expect(calls()).toBe(2);
  });

  it('TTL 过期后重新调用', async () => {
    const { provider, calls } = countingProvider();
    const cached = withLlmCache(provider, 'test|m|e');
    await cached.complete('p');
    // 把缓存文件 mtime 拨回 8 天前
    const { readdirSync } = await import('node:fs');
    const f = join(llmCacheDir(), readdirSync(llmCacheDir())[0]);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    utimesSync(f, old, old);
    await cached.complete('p');
    expect(calls()).toBe(2);
  });

  it('createLlmFromEnv 集成：.env NANGYING_LLM_CACHE=1 时经 fetchImpl 只调一次', async () => {
    const dotEnv = join(tmp, '.env');
    writeFileSync(dotEnv, 'MINIMAX_API_KEY=sk-cache-test-123456\nNANGYING_LLM_CACHE=1\n', 'utf8');
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: ' cached-ok ' } }] }), { status: 200 });
    }) as typeof fetch;
    const llm = createLlmFromEnv({ dotEnvPath: dotEnv, fetchImpl })!;
    expect(await llm.complete('判定 X')).toBe('cached-ok');
    expect(await llm.complete('判定 X')).toBe('cached-ok');
    expect(fetches).toBe(1);
  });

  it('未开启 NANGYING_LLM_CACHE 时不走缓存', async () => {
    const dotEnv = join(tmp, '.env');
    writeFileSync(dotEnv, 'MINIMAX_API_KEY=sk-cache-test-123456\n', 'utf8');
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 });
    }) as typeof fetch;
    const llm = createLlmFromEnv({ dotEnvPath: dotEnv, fetchImpl })!;
    await llm.complete('判定 Y');
    await llm.complete('判定 Y');
    expect(fetches).toBe(2);
  });
});
