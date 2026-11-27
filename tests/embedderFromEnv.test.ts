import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmbedderFromEnv, resolveEmbeddingsEndpoint } from '../adapters/core/embedderFromEnv.js';
import { validateApplySettings, GENERIC_POLICY } from '../core/config/settingsCard.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

describe('resolveEmbeddingsEndpoint：端点归一', () => {
  it('/vN 补 /embeddings；裸域补 /v1/embeddings；已含路径原样', () => {
    expect(resolveEmbeddingsEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/embeddings');
    expect(resolveEmbeddingsEndpoint('https://api.example.com')).toBe('https://api.example.com/v1/embeddings');
    expect(resolveEmbeddingsEndpoint('http://localhost:11434/v1/embeddings')).toBe('http://localhost:11434/v1/embeddings');
    expect(resolveEmbeddingsEndpoint('https://api.example.com/v1/')).toBe('https://api.example.com/v1/embeddings');
  });
});

describe('createEmbedderFromEnv', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  function tempConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'nangying-emb-'));
    process.env.NANGYING_CONFIG_DIR = dir;
    return dir;
  }

  it('baseUrl/model 不齐备返回 undefined（纯倒排降级）', () => {
    const dir = tempConfigDir();
    try {
      const emptyEnv = join(dir, '.env');
      writeFileSync(emptyEnv, '', 'utf8');
      expect(createEmbedderFromEnv({ dotEnvPath: emptyEnv })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('.env 提供 baseUrl+model 即构造；embed 解析 data 按 index 排序；key 走 Bearer', async () => {
    const dir = tempConfigDir();
    try {
      const envPath = join(dir, '.env');
      writeFileSync(envPath, 'NANGYING_EMBEDDINGS_BASE_URL=https://emb.example.com/v1\nNANGYING_EMBEDDINGS_MODEL=bge-m3\nNANGYING_EMBEDDINGS_API_KEY=test-key-123456\n', 'utf8');
      let seenAuth = '';
      let seenBody = '';
      const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
        seenAuth = String((init?.headers as Record<string, string>).authorization ?? '');
        seenBody = String(init?.body ?? '');
        return new Response(JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }), { status: 200 });
      }) as typeof fetch;
      const emb = createEmbedderFromEnv({ dotEnvPath: envPath, fetchImpl })!;
      expect(emb.model).toBe('bge-m3');
      const vecs = await emb.embed(['甲', '乙']);
      expect(vecs).toEqual([[1, 0], [0, 1]]);
      expect(seenAuth).toBe('Bearer test-key-123456');
      expect(JSON.parse(seenBody)).toEqual({ model: 'bge-m3', input: ['甲', '乙'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('HTTP 错误抛错且 key 脱敏', async () => {
    const dir = tempConfigDir();
    try {
      const envPath = join(dir, '.env');
      writeFileSync(envPath, 'NANGYING_EMBEDDINGS_BASE_URL=https://emb.example.com/v1\nNANGYING_EMBEDDINGS_MODEL=m\nNANGYING_EMBEDDINGS_API_KEY=secret-key-abcdef\n', 'utf8');
      const fetchImpl = (async () => new Response('invalid key secret-key-abcdef', { status: 401 })) as typeof fetch;
      const emb = createEmbedderFromEnv({ dotEnvPath: envPath, fetchImpl })!;
      await expect(emb.embed(['x'])).rejects.toThrow('HTTP 401');
      await expect(emb.embed(['x'])).rejects.not.toThrow('secret-key-abcdef');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('settings_card 向量端点字段', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('validateApplySettings：接受三字段；非法 URL 拒绝；空串=清除合法', () => {
    const ok = validateApplySettings({ embeddingsBaseUrl: 'https://emb.example.com/v1', embeddingsModel: 'bge-m3', embeddingsApiKey: 'k' }, GENERIC_POLICY);
    expect('ok' in ok && ok.ok).toBe(true);
    const bad = validateApplySettings({ embeddingsBaseUrl: 'ftp://x' }, GENERIC_POLICY);
    expect('error' in bad && bad.error).toContain('http(s) URL');
    const clear = validateApplySettings({ embeddingsBaseUrl: '', embeddingsModel: '', embeddingsApiKey: '' }, GENERIC_POLICY);
    expect('ok' in clear && clear.ok).toBe(true);
  });

  it('apply：extra.embeddings merge 写入且解码器/LLM 配置原样保留；status 回显脱敏', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nangying-emb-'));
    process.env.NANGYING_CONFIG_DIR = dir;
    try {
      const adapter = new LocalAdapter();
      // 先写解码器配置 + LLM extra（验证 merge 不破坏）
      await adapter.invokeSkill('settings_card', { inputs: { stage: 'apply', settings: { provider: 'local-ocr' } } });
      const { writeConfig, readConfig } = await import('../adapters/core/configStore.js');
      writeConfig({ ...readConfig()!, extra: { ...readConfig()!.extra, llm: '{"provider":"deepseek"}' } });

      const applied = await adapter.invokeSkill('settings_card', {
        inputs: { stage: 'apply', settings: { embeddingsBaseUrl: 'https://emb.example.com/v1', embeddingsModel: 'bge-m3', embeddingsApiKey: 'emb-key-999' } },
      });
      expect(applied.level).toBe('full');
      expect(applied.degradationNote).toBe('');
      const cfg = readConfig()!;
      expect(cfg.provider).toBe('local-ocr'); // 解码器位不被占用
      expect(cfg.extra?.llm).toBe('{"provider":"deepseek"}'); // extra.llm 幸存
      expect(JSON.parse(cfg.extra!.embeddings!)).toEqual({ baseUrl: 'https://emb.example.com/v1', model: 'bge-m3' });

      const status = await adapter.invokeSkill('settings_card', { inputs: { stage: 'status' } });
      const data = status.data as { embeddings: { baseUrl: string; model: string; apiKey: { configured: boolean; fingerprint?: string } } };
      expect(data.embeddings.baseUrl).toBe('https://emb.example.com/v1');
      expect(data.embeddings.model).toBe('bge-m3');
      expect(data.embeddings.apiKey.configured).toBe(true);
      expect(data.embeddings.apiKey.fingerprint).toBe('…-999');
      expect(JSON.stringify(status.data)).not.toContain('emb-key-999');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('卡片渲染含 embeddings 区块三字段', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('settings_card', { inputs: { stage: 'render' } });
    const card = (r.data as { card: { sections: Array<{ id: string; fields: Array<{ name: string }> }> } }).card;
    const sec = card.sections.find((s) => s.id === 'embeddings');
    expect(sec).toBeTruthy();
    expect(sec!.fields.map((f) => f.name)).toEqual(['embeddingsBaseUrl', 'embeddingsModel', 'embeddingsApiKey']);
  });
});
