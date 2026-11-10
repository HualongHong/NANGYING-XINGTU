import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv } from '../adapters/core/dotenv.js';
import { createLlmFromEnv, resolveChatEndpoint } from '../adapters/core/llmFromEnv.js';

const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  Object.assign(process.env, savedEnv);
});

function tempFile(content: string): string {
  const d = mkdtempSync(join(tmpdir(), 'ny-dotenv-'));
  dirs.push(d);
  const f = join(d, '.env');
  writeFileSync(f, content, 'utf8');
  return f;
}

describe('loadDotEnv（零依赖 .env 加载）', () => {
  it('解析键值、跳过注释/空行/非法行、去成对引号', () => {
    const f = tempFile([
      '# 注释行',
      '',
      'MINIMAX_API_KEY=abc-123',
      'DEEPSEEK_API_KEY="quoted-value"',
      "BAD LINE WITHOUT EQ",
      '1INVALID=x',
      'EMPTY=',
    ].join('\n'));
    const loaded = loadDotEnv(f);
    expect(loaded.MINIMAX_API_KEY).toBe('abc-123');
    expect(loaded.DEEPSEEK_API_KEY).toBe('quoted-value');
    expect(loaded.EMPTY).toBe('');
    expect(loaded['1INVALID']).toBeUndefined();
    expect(loaded['BAD LINE WITHOUT EQ']).toBeUndefined();
  });

  it('不覆盖已存在的环境变量', () => {
    process.env.NY_TEST_EXISTING = 'original';
    const f = tempFile('NY_TEST_EXISTING=from-file\nNY_TEST_NEW=added\n');
    loadDotEnv(f);
    expect(process.env.NY_TEST_EXISTING).toBe('original');
    expect(process.env.NY_TEST_NEW).toBe('added');
  });
});

describe('resolveChatEndpoint（端点归一）', () => {
  it('补 /v1/chat/completions 或 /chat/completions', () => {
    expect(resolveChatEndpoint('https://api.deepseek.com', 'deepseek'))
      .toBe('https://api.deepseek.com/v1/chat/completions');
    expect(resolveChatEndpoint('https://api.minimaxi.com/v1', 'minimax'))
      .toBe('https://api.minimaxi.com/v1/chat/completions');
    expect(resolveChatEndpoint('https://api.minimaxi.com/v1/chat/completions', 'minimax'))
      .toBe('https://api.minimaxi.com/v1/chat/completions');
  });
});

describe('createLlmFromEnv（LocalAdapter 的 .env 回退）', () => {
  it('假 .env 密钥 → 返回 provider；请求错误中 key 被脱敏为 ***', async () => {
    const f = tempFile('DEEPSEEK_API_KEY=fake-key-abcdef123456\n');
    const calls: string[] = [];
    const llm = createLlmFromEnv({
      dotEnvPath: f,
      fetchImpl: (async (url: unknown) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ error: 'invalid key fake-key-abcdef123456' }), { status: 401 });
      }) as typeof fetch,
    });
    expect(llm).toBeTruthy();
    await expect(llm!.complete('测试')).rejects.toThrow('HTTP 401');
    try {
      await llm!.complete('测试');
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain('***'); // key 子串被脱敏
      expect(msg).not.toContain('fake-key-abcdef123456');
    }
    expect(calls[0]).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('成功路径：剥离 <think> 段返回 content（key 不出现在任何输出）', async () => {
    const f = tempFile('DEEPSEEK_API_KEY=fake-key-abcdef123456\n');
    const llm = createLlmFromEnv({
      dotEnvPath: f,
      fetchImpl: (async () => new Response(JSON.stringify({
        choices: [{ message: { content: '<think>推理过程</think>  ["x"]' } }],
      }), { status: 200 })) as typeof fetch,
    });
    const out = await llm!.complete('p');
    expect(out).toBe('["x"]');
    expect(out).not.toContain('fake-key');
  });

  it('无可用密钥 → 返回 undefined（调用方走无 LLM 路径）', () => {
    const d = mkdtempSync(join(tmpdir(), 'ny-empty-'));
    dirs.push(d);
    expect(createLlmFromEnv({ dotEnvPath: join(d, '.env') })).toBeUndefined();
  });
});
