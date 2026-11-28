import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { writeApiKey } from '../adapters/core/configStore.js';
import { redactSecrets, redactDeep, resetRedactCache } from '../adapters/core/redact.js';
import { handleMessage } from '../server/mcp.js';
import { startHttpServer } from '../server/http.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import type { AdapterBase } from '../adapters/core/adapter.base.js';

let tmp: string;
let savedConfigDir: string | undefined;
let savedToken: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'redact-'));
  savedConfigDir = process.env.NANGYING_CONFIG_DIR;
  process.env.NANGYING_CONFIG_DIR = join(tmp, 'cfg');
  savedToken = process.env.NANGYING_HTTP_TOKEN;
  delete process.env.NANGYING_HTTP_TOKEN;
  resetRedactCache();
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.NANGYING_CONFIG_DIR;
  else process.env.NANGYING_CONFIG_DIR = savedConfigDir;
  if (savedToken === undefined) delete process.env.NANGYING_HTTP_TOKEN;
  else process.env.NANGYING_HTTP_TOKEN = savedToken;
  delete process.env.TEST_REDACT_TOKEN;
  resetRedactCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('redactSecrets 密钥脱敏', () => {
  it('secrets.json 中的密钥值被替换为 ***', () => {
    writeApiKey('sk-live-abcdef123456', 'mineruApiKey');
    resetRedactCache();
    expect(redactSecrets('401 Unauthorized: key sk-live-abcdef123456 rejected'))
      .toBe('401 Unauthorized: key *** rejected');
  });

  it('环境变量中名字含 TOKEN/KEY 的值被替换', () => {
    process.env.TEST_REDACT_TOKEN = 'tok-xyz-987654321';
    resetRedactCache();
    expect(redactSecrets('connect with tok-xyz-987654321 failed')).toBe('connect with *** failed');
  });

  it('短值（<8）不脱敏，普通文本原样返回', () => {
    process.env.TEST_REDACT_TOKEN = 'short';
    resetRedactCache();
    expect(redactSecrets('short mention')).toBe('short mention');
    expect(redactSecrets('没有任何密钥的文本')).toBe('没有任何密钥的文本');
  });

  it('redactDeep 递归处理嵌套对象与数组', () => {
    writeApiKey('sk-live-abcdef123456');
    resetRedactCache();
    const out = redactDeep({
      a: 'key=sk-live-abcdef123456',
      b: ['ok', { c: 'sk-live-abcdef123456 tail' }],
      n: 42,
    });
    expect(out).toEqual({ a: 'key=***', b: ['ok', { c: '*** tail' }], n: 42 });
  });

  it('handleMessage 错误通道不泄露密钥', async () => {
    writeApiKey('sk-live-abcdef123456');
    resetRedactCache();
    const broken = {
      invokeSkill: () => { throw new Error('provider 401: Authorization Bearer sk-live-abcdef123456'); },
      listSkills: () => [],
    } as unknown as AdapterBase;
    const resp = await handleMessage(broken, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'x', arguments: {} },
    });
    expect(resp!.error!.message).toContain('***');
    expect(resp!.error!.message).not.toContain('sk-live-abcdef123456');
  });
});

describe('HTTP Bearer 鉴权（NANGYING_HTTP_TOKEN）', () => {
  let server: Server | undefined;
  afterAll(async () => {
    if (server) await new Promise((r) => server!.close(r));
  });

  async function post(port: number, headers: Record<string, string> = {}) {
    const resp = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    return resp;
  }

  it('未设置 token 时本机直放行', async () => {
    server = await startHttpServer(new LocalAdapter(), 0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    expect((await post(port)).status).toBe(200);
  });

  it('设置 token 后：无头/错 token 401，正确 token 200', async () => {
    process.env.NANGYING_HTTP_TOKEN = 'bench-token-123456';
    server = await startHttpServer(new LocalAdapter(), 0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    expect((await post(port)).status).toBe(401);
    expect((await post(port, { authorization: 'Bearer wrong-token-000' })).status).toBe(401);
    expect((await post(port, { authorization: 'Bearer bench-token-123456' })).status).toBe(200);
  });
});
