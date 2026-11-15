import { describe, expect, it } from 'vitest';
import { createMineruDecoder, extractMarkdownFromZip, MINERU_FLASH_MAX_BYTES } from '../adapters/odlab/mineru.js';
import { createDecoder } from '../adapters/core/decoders/factory.js';
import { buildMiniZip } from './helpers/miniPptx.js';

const TOKEN = 'test-mineru-token-ab12';

/** 可编程 fetch mock：按 URL 匹配响应序列 */
function mockFetch(handlers: Array<{ match: RegExp; responses: Array<{ status?: number; body: unknown }> }>) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    const h = handlers.find((x) => x.match.test(u));
    if (!h) return new Response('not found', { status: 404 });
    const n = counts.get(u) ?? 0;
    counts.set(u, n + 1);
    const r = h.responses[Math.min(n, h.responses.length - 1)];
    const payload =
      r.body instanceof Uint8Array
        ? Buffer.from(r.body)
        : typeof r.body === 'string'
          ? r.body
          : JSON.stringify(r.body);
    return new Response(payload, {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const MD = '# 解析结果\n\n表格与公式已结构化。';

function zipWithMd(): Uint8Array {
  // buildMiniZip 直接返回 Buffer（非 { bytes } 包装）
  return new Uint8Array(buildMiniZip([{ name: 'full.md', data: Buffer.from(MD, 'utf8') }]));
}

describe('MinerU 解码器（adapters/odlab/mineru.ts）', () => {
  it('免费档：无 Token 走签名上传三段式（申请→PUT→轮询→下载 Markdown）', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        match: /\/api\/v1\/agent\/parse\/file$/,
        responses: [{ body: { code: 0, data: { task_id: 't-flash', file_url: 'https://oss-mineru.example/up' } } }],
      },
      { match: /oss-mineru\.example\/up$/, responses: [{ status: 200, body: '' }] },
      {
        match: /\/api\/v1\/agent\/parse\/t-flash$/,
        responses: [
          { body: { code: 0, data: { state: 'running' } } },
          { body: { code: 0, data: { state: 'done', markdown_url: 'https://cdn-mineru.example/full.md' } } },
        ],
      },
      { match: /cdn-mineru\.example\/full\.md$/, responses: [{ body: MD }] },
    ]);
    const decoder = createMineruDecoder({
      config: { provider: 'mineru', extra: { pollIntervalMs: '1' } },
      keyProvider: () => undefined,
      fetchImpl,
    });
    const doc = await decoder.decode({ data: new Uint8Array([1, 2, 3]), materialType: 'pdf' });
    expect(doc.content).toBe(MD);
    expect(doc.note).toContain('flash');
    expect(calls[0]).toContain('/api/v1/agent/parse/file');
    expect(calls[1]).toContain('oss-mineru.example/up');
    expect(calls.some((u) => u.includes('/api/v1/agent/parse/t-flash'))).toBe(true);
    expect(calls.some((u) => u.includes('cdn-mineru.example/full.md'))).toBe(true);
  });

  it('免费档：任务 failed 带 err_code 抛结构化错误', async () => {
    const { fetchImpl } = mockFetch([
      {
        match: /\/api\/v1\/agent\/parse\/file$/,
        responses: [{ body: { code: 0, data: { task_id: 't-bad', file_url: 'https://oss-mineru.example/up2' } } }],
      },
      { match: /oss-mineru\.example\/up2$/, responses: [{ status: 200, body: '' }] },
      {
        match: /\/api\/v1\/agent\/parse\/t-bad$/,
        responses: [{ body: { code: 0, data: { state: 'failed', err_code: -30003, err_msg: '页数超限' } } }],
      },
    ]);
    const decoder = createMineruDecoder({
      config: { provider: 'mineru', extra: { pollIntervalMs: '1' } },
      keyProvider: () => undefined,
      fetchImpl,
    });
    await expect(decoder.decode({ data: new Uint8Array([1]), materialType: 'pdf' })).rejects.toThrow('MinerU 免费档解析失败（-30003）：页数超限');
  });

  it('免费档：>10MB 拒绝并提示精准档（不发起请求）', async () => {
    const { fetchImpl, calls } = mockFetch([]);
    const decoder = createMineruDecoder({
      config: { provider: 'mineru' },
      keyProvider: () => undefined,
      fetchImpl,
    });
    const big = new Uint8Array(MINERU_FLASH_MAX_BYTES + 1);
    await expect(decoder.decode({ data: big, materialType: 'pdf' })).rejects.toThrow('免费档单文件 ≤10MB');
    expect(calls).toHaveLength(0);
  });

  it('精准档：批量上传通道（file-urls/batch→PUT→轮询→下载 zip 取 full.md）', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        match: /\/api\/v4\/file-urls\/batch$/,
        responses: [{ body: { code: 0, data: { batch_id: 'b-123', file_urls: ['https://oss.example/up'] } } }],
      },
      { match: /oss\.example\/up$/, responses: [{ status: 200, body: '' }] },
      {
        match: /\/api\/v4\/extract-results\/batch\/b-123$/,
        responses: [
          { body: { code: 0, data: { extract_result: [{ state: 'running' }] } } },
          { body: { code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://cdn.example/result.zip' }] } } },
        ],
      },
      { match: /cdn\.example\/result\.zip$/, responses: [{ body: zipWithMd() }] },
    ]);
    const decoder = createMineruDecoder({
      config: { provider: 'mineru', extra: { pollIntervalMs: '1' } },
      keyProvider: () => TOKEN,
      fetchImpl,
    });
    const doc = await decoder.decode({ data: new Uint8Array([9, 9]), materialType: 'pdf' });
    expect(doc.content).toBe(MD);
    expect(doc.note).toContain('precise');
    expect(calls.some((u) => u.includes('/api/v4/file-urls/batch'))).toBe(true);
    expect(calls.some((u) => u.includes('oss.example/up'))).toBe(true);
    expect(calls.some((u) => u.includes('cdn.example/result.zip'))).toBe(true);
  });

  it('精准档：任务 failed 抛结构化错误', async () => {
    const { fetchImpl } = mockFetch([
      {
        match: /\/api\/v4\/file-urls\/batch$/,
        responses: [{ body: { code: 0, data: { batch_id: 'b-9', file_urls: ['https://oss.example/up9'] } } }],
      },
      { match: /oss\.example\/up9$/, responses: [{ status: 200, body: '' }] },
      {
        match: /\/api\/v4\/extract-results\/batch\/b-9$/,
        responses: [{ body: { code: 0, data: { extract_result: [{ state: 'failed', err_msg: '页数超限' }] } } }],
      },
    ]);
    const decoder = createMineruDecoder({
      config: { provider: 'mineru', extra: { pollIntervalMs: '1' } },
      keyProvider: () => TOKEN,
      fetchImpl,
    });
    await expect(decoder.decode({ data: new Uint8Array([1]), materialType: 'pdf' })).rejects.toThrow('MinerU 精准档解析失败：页数超限');
  });

  it('精准档：轮询超时抛错（预算可经 extra.pollBudgetMs 配置）', async () => {
    const { fetchImpl } = mockFetch([
      {
        match: /\/api\/v4\/file-urls\/batch$/,
        responses: [{ body: { code: 0, data: { batch_id: 'b-slow', file_urls: ['https://oss.example/ups'] } } }],
      },
      { match: /oss\.example\/ups$/, responses: [{ status: 200, body: '' }] },
      {
        match: /\/api\/v4\/extract-results\/batch\/b-slow$/,
        responses: [{ body: { code: 0, data: { extract_result: [{ state: 'running' }] } } }],
      },
    ]);
    const decoder = createMineruDecoder({
      config: { provider: 'mineru', extra: { pollIntervalMs: '1', pollBudgetMs: '30' } },
      keyProvider: () => TOKEN,
      fetchImpl,
    });
    await expect(decoder.decode({ data: new Uint8Array([1]), materialType: 'pdf' })).rejects.toThrow('解析超时');
  });

  it('业务信封错误：HTTP 200 + code!=0 抛结构化错误并脱敏', async () => {
    const { fetchImpl } = mockFetch([
      {
        match: /\/api\/v4\/file-urls\/batch$/,
        responses: [{ status: 200, body: { code: -60009, msg: `任务提交队列已满 ${TOKEN}`, data: null } }],
      },
    ]);
    const decoder = createMineruDecoder({
      config: { provider: 'mineru' },
      keyProvider: () => TOKEN,
      fetchImpl,
    });
    try {
      await decoder.decode({ data: new Uint8Array([1]), materialType: 'pdf' });
      expect.unreachable();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('MinerU 业务错误（code=-60009）');
      expect(msg).not.toContain(TOKEN);
      expect(msg).toContain('***');
    }
  });

  it('错误消息脱敏：HTTP 错误体中的 Token 子串被 redact', async () => {
    const { fetchImpl } = mockFetch([
      { match: /\/api\/v4\/file-urls\/batch$/, responses: [{ status: 401, body: `invalid token ${TOKEN}` }] },
    ]);
    const decoder = createMineruDecoder({
      config: { provider: 'mineru' },
      keyProvider: () => TOKEN,
      fetchImpl,
    });
    try {
      await decoder.decode({ data: new Uint8Array([1]), materialType: 'pdf' });
      expect.unreachable();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(TOKEN);
      expect(msg).toContain('***');
    }
  });

  it('免费档：xlsx 走 Office 原生解析，file_name 携带正确扩展名', async () => {
    const bodies: string[] = [];
    const { fetchImpl } = mockFetch([
      {
        match: /\/api\/v1\/agent\/parse\/file$/,
        responses: [{ body: { code: 0, data: { task_id: 't-xlsx', file_url: 'https://oss-mineru.example/upx' } } }],
      },
      { match: /oss-mineru\.example\/upx$/, responses: [{ status: 200, body: '' }] },
      {
        match: /\/api\/v1\/agent\/parse\/t-xlsx$/,
        responses: [{ body: { code: 0, data: { state: 'done', markdown_url: 'https://cdn-mineru.example/x.md' } } }],
      },
      { match: /cdn-mineru\.example\/x\.md$/, responses: [{ body: MD }] },
    ]);
    const capturing = (async (url: string, init?: RequestInit) => {
      if (url.includes('/parse/file') && init?.body) bodies.push(String(init.body));
      return fetchImpl(url, init);
    }) as typeof fetch;
    const decoder = createMineruDecoder({
      config: { provider: 'mineru' },
      keyProvider: () => undefined,
      fetchImpl: capturing,
    });
    const doc = await decoder.decode({ data: new Uint8Array([1]), materialType: 'xlsx' });
    expect(doc.content).toBe(MD);
    expect(bodies[0]).toContain('"file_name":"document.xlsx"');
  });

  it('extractMarkdownFromZip：优先 full.md，无 md 返回 undefined', async () => {
    expect(extractMarkdownFromZip(zipWithMd())).toBe(MD);
    const noMd = buildMiniZip([{ name: 'doc.txt', data: Buffer.from('x') }]);
    expect(extractMarkdownFromZip(new Uint8Array(noMd))).toBeUndefined();
    expect(extractMarkdownFromZip(new Uint8Array([0, 1, 2]))).toBeUndefined();
  });

  it('工厂路由：createDecoder(provider="mineru") 接的就是 MinerU 解码器（解码阶梯③号位同路径）', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        match: /\/api\/v1\/agent\/parse\/file$/,
        responses: [{ body: { code: 0, data: { task_id: 't-route', file_url: 'https://oss-mineru.example/upr' } } }],
      },
      { match: /oss-mineru\.example\/upr$/, responses: [{ status: 200, body: '' }] },
      {
        match: /\/api\/v1\/agent\/parse\/t-route$/,
        responses: [{ body: { code: 0, data: { state: 'done', markdown_url: 'https://cdn-mineru.example/r.md' } } }],
      },
      { match: /cdn-mineru\.example\/r\.md$/, responses: [{ body: MD }] },
    ]);
    const decoder = createDecoder({ provider: 'mineru' }, () => undefined, { fetchImpl });
    const doc = await decoder.decode({ data: new Uint8Array([7]), materialType: 'pdf' });
    expect(doc.content).toBe(MD);
    expect(calls[0]).toContain('mineru.net');
  });
});
