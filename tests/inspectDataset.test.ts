import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import { createOdlabDatasetClient, OdlabAuthError } from '../adapters/odlab/datasets.js';
import {
  planInspectDataset,
  repoToApiName,
  scoreTeachingRelevance,
  normalizeFiles,
  normalizeInfo,
} from '../core/dataset/inspectDataset.js';

const AK = 'ak-demo-0001';
const SK = 'sk-demo-0001';
const INFO = { name: 'demo-set', description: '教学题库', visibility: 'public', tags: ['教育'], fileCount: 3, totalBytes: 1024 };
const FILES = [
  { path: 'data/期中试卷.pdf', size: 100 },
  { path: 'data/教材扫描件/', size: 0, type: 'dir' },
  { path: 'README.md', size: 10 },
];

/** 可编程 mock fetch（URL 匹配 + 响应序列 + 请求记录） */
function mockFetch(handlers: Array<{ match: RegExp; responses: Array<{ status?: number; body: unknown }> }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const h = handlers.find((x) => x.match.test(u));
    if (!h) return new Response('not found', { status: 404 });
    const n = counts.get(u) ?? 0;
    counts.set(u, n + 1);
    const r = h.responses[Math.min(n, h.responses.length - 1)];
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('数据集探查核心（core/dataset/inspectDataset.ts）', () => {
  it('planInspectDataset：默认值/上限/prefix 防护/repo 形态', () => {
    expect(planInspectDataset({ repo: 'OpenDataLab/UniTE' })).toEqual({
      ok: true, repo: 'OpenDataLab/UniTE', listFiles: true, maxFiles: 200,
    });
    expect(planInspectDataset({ repo: 'a/b', listFiles: false, maxFiles: 5, prefix: '/data/' }))
      .toEqual({ ok: true, repo: 'a/b', listFiles: false, maxFiles: 5, prefix: 'data' });
    expect(planInspectDataset({})).toHaveProperty('error');
    expect(planInspectDataset({ repo: 'no-slash' })).toHaveProperty('error');
    expect(planInspectDataset({ repo: 'a/b c' })).toHaveProperty('error');
    expect(planInspectDataset({ repo: 'a/b', maxFiles: 0 })).toHaveProperty('error');
    expect(planInspectDataset({ repo: 'a/b', maxFiles: 1001 })).toHaveProperty('error');
    expect(planInspectDataset({ repo: 'a/b', prefix: '../etc' })).toHaveProperty('error');
  });

  it('repoToApiName：斜杠转逗号（官方 SDK 规则）', () => {
    expect(repoToApiName('OpenDataLab/UniTE')).toBe('OpenDataLab,UniTE');
  });

  it('scoreTeachingRelevance：试题/教材→high，课程类→medium，无命中→low', () => {
    expect(scoreTeachingRelevance(['data/期中试卷.pdf', '教材第3章.pdf']).level).toBe('high');
    const m = scoreTeachingRelevance(['student/records/worksheet.pdf']);
    expect(m.level).toBe('medium');
    expect(m.matched.length).toBeGreaterThan(0);
    expect(scoreTeachingRelevance(['images/cat.png']).level).toBe('low');
  });

  it('normalizeFiles/normalizeInfo：字段缺失的安全缺省与 visibility 映射', () => {
    const files = normalizeFiles([{ path: 'a.txt', size: 5 }, { name: 'b/' }, { bad: 1 }, 'x']);
    expect(files).toEqual([
      { path: 'a.txt', size: 5, isDir: false },
      { path: 'b/', size: 0, isDir: true },
    ]);
    const info = normalizeInfo('u/r', { description: 'd', visibility: 'Public', tags: ['x'], fileCount: 9 });
    expect(info).toMatchObject({ repo: 'u/r', owner: 'u', name: 'r', visibility: 'public', fileCount: 9, source: 'opendatalab' });
    expect(normalizeInfo('u/r', null).visibility).toBe('unknown');
  });
});

describe('OpenDataLab 数据集客户端（adapters/odlab/datasets.ts）', () => {
  it('公共仓库匿名探查：info + listFiles（含逗号仓库名与分页游标）', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: /datasets\/OpenDataLab(%2C|,)UniTE$/, responses: [{ body: { data: INFO } }] },
      { match: /r\/main\?/, responses: [{ body: { data: { list: FILES, nextCursor: 'c-2' } } }] },
    ]);
    const client = createOdlabDatasetClient({ akProvider: () => undefined, skProvider: () => undefined, fetchImpl });
    const info = (await client.info('OpenDataLab/UniTE')) as { name: string };
    expect(info.name).toBe('demo-set');
    const list = await client.listFiles('OpenDataLab/UniTE', { limit: 200 });
    expect((list.raw as { list: unknown[] }).list).toHaveLength(3);
    expect(list.nextCursor).toBe('c-2');
    expect(calls.every((c) => !String(c.init?.headers ?? {}).includes('Authorization'))).toBe(true);
  });

  it('受限仓库 401 → AK/SK 挑战式鉴权（HMAC 签名正确）→ Bearer 重试成功', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: /datasets\/u(%2C|,)private$/, responses: [
        { status: 401, body: { msg: 'unauthorized' } },
        { body: { data: INFO } },
      ] },
      { match: /\/open\/auth$/, responses: [{ body: { data: { nonce: 'nonce-abc', algorithm: 'HmacSHA256' } } }] },
      { match: /\/open\/getJwt$/, responses: [{ body: { data: { token: 'jwt-abc', expiresIn: '3600' } } }] },
    ]);
    const client = createOdlabDatasetClient({ akProvider: () => AK, skProvider: () => SK, fetchImpl });
    const info = (await client.info('u/private')) as { name: string };
    expect(info.name).toBe('demo-set');
    // 校验 d = base64(HMAC-SHA256(SK, nonce))（复刻官方算法）
    const getJwtCall = calls.find((c) => /getJwt$/.test(c.url));
    const body = JSON.parse(String(getJwtCall?.init?.body)) as { ak: string; d: string };
    expect(body.ak).toBe(AK);
    const expected = createHmac('sha256', SK).update('nonce-abc').digest('base64');
    expect(body.d).toBe(expected);
    // 重试带 Bearer
    const retry = calls.filter((c) => /datasets\/u(%2C|,)private$/.test(c.url))[1];
    expect(String((retry.init?.headers as Record<string, string>).Authorization)).toBe('Bearer jwt-abc');
  });

  it('401 且无凭据 → OdlabAuthError（执行器据其输出配置引导）', async () => {
    const { fetchImpl } = mockFetch([
      { match: /datasets\/u(%2C|,)private$/, responses: [{ status: 401, body: '{}' }] },
    ]);
    const client = createOdlabDatasetClient({ akProvider: () => undefined, skProvider: () => undefined, fetchImpl });
    await expect(client.info('u/private')).rejects.toBeInstanceOf(OdlabAuthError);
    await expect(client.info('u/private')).rejects.toThrow('odlabAccessKeyId');
  });
});

describe('教学数据集探查技能（inspect_teaching_dataset 执行器）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENXLAB_AK;
    delete process.env.OPENXLAB_SK;
  });

  function stubGlobalFetch(handlers: Parameters<typeof mockFetch>[0]) {
    const { fetchImpl, calls } = mockFetch(handlers);
    vi.stubGlobal('fetch', fetchImpl);
    return calls;
  }

  it('full：公共仓库匿名探查 → 元信息+文件+教学相关性（global fetch 全链路）', async () => {
    stubGlobalFetch([
      { match: /datasets\/OpenDataLab(%2C|,)UniTE$/, responses: [{ body: { data: INFO } }] },
      { match: /r\/main\?/, responses: [{ body: { data: { list: FILES } } }] },
    ]);
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('inspect_teaching_dataset', {
      inputs: { repo: 'OpenDataLab/UniTE' },
    });
    expect(r.level).toBe('full');
    const d = r.data as { name: string; files: unknown[]; teachingRelevance: string; matchedKeywords: string[]; source: string; truncated: boolean };
    expect(d.name).toBe('demo-set');
    expect(d.files).toHaveLength(3);
    expect(d.teachingRelevance).toBe('high');
    expect(d.matchedKeywords).toContain('试卷');
    expect(d.source).toBe('opendatalab');
    expect(d.truncated).toBe(false);
  });

  it('degraded：元信息可得但清单失败 → 半量返回 + degradationNote', async () => {
    stubGlobalFetch([
      { match: /datasets\/u(%2C|,)pub$/, responses: [{ body: { data: INFO } }] },
      { match: /r\/main\?/, responses: [{ status: 500, body: 'boom' }] },
    ]);
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('inspect_teaching_dataset', {
      inputs: { repo: 'u/pub' },
    });
    expect(r.level).toBe('degraded');
    expect(r.degradationNote).toContain('文件清单获取失败');
    const d = r.data as { name: string; files: unknown[]; truncated: boolean };
    expect(d.name).toBe('demo-set');
    expect(d.files).toEqual([]);
    expect(d.truncated).toBe(true);
  });

  it('AUTH_REQUIRED：受限仓库无 AK/SK → errorCode AUTH_REQUIRED + 配置引导', async () => {
    stubGlobalFetch([
      { match: /datasets\/u(%2C|,)private$/, responses: [{ status: 401, body: '{}' }] },
    ]);
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('inspect_teaching_dataset', {
      inputs: { repo: 'u/private' },
    });
    expect(r.level).toBe('unavailable');
    expect(r.errorCode).toBe('AUTH_REQUIRED');
    expect(r.degradationNote).toContain('odlabAccessKeyId');
  });

  it('PLATFORM_UNAVAILABLE：网络失败 → 结构化错误，不影响主流程', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch);
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('inspect_teaching_dataset', {
      inputs: { repo: 'u/pub' },
    });
    expect(r.level).toBe('unavailable');
    expect(r.errorCode).toBe('PLATFORM_UNAVAILABLE');
    expect(r.degradationNote).toContain('不影响课程生产主流程');
  });

  it('INVALID_INPUT：repo 缺失/形态非法', async () => {
    const adapter = new LocalAdapter();
    for (const inputs of [{}, { repo: 'bad' }, { repo: 'a/b', maxFiles: 9999 }]) {
      const r = await adapter.invokeSkill('inspect_teaching_dataset', { inputs });
      expect(r.level).toBe('unavailable');
      expect(r.errorCode).toBe('INVALID_INPUT');
    }
  });

  it('经 settings_card 写入 AK/SK 后，探查受限仓库走鉴权重试（OPENXLAB_AK 通道同样生效）', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ny-odlab-'));
    process.env.NANGYING_CONFIG_DIR = dir;
    const calls = stubGlobalFetch([
      { match: /datasets\/u(%2C|,)private$/, responses: [
        { status: 401, body: '{}' },
        { body: { data: INFO } },
      ] },
      { match: /r\/main\?/, responses: [{ body: { data: { list: FILES } } }] },
      { match: /\/open\/auth$/, responses: [{ body: { data: { nonce: 'n1', algorithm: 'HmacSHA256' } } }] },
      { match: /\/open\/getJwt$/, responses: [{ body: { data: { token: 'jwt-x', expiresIn: '3600' } } }] },
    ]);
    try {
      const adapter = new LocalAdapter();
      // 先经 settings_card 写入成对密钥
      const apply = await adapter.invokeSkill('settings_card', {
        inputs: { stage: 'apply', platform: 'local', settings: { odlabAccessKeyId: AK, odlabSecretAccessKey: SK } },
      });
      expect(apply.level).toBe('full');
      // 再探查受限仓库：401 → 自动鉴权重试
      const r = await adapter.invokeSkill('inspect_teaching_dataset', { inputs: { repo: 'u/private' } });
      expect(r.level).toBe('full');
      expect(calls.some((c) => /getJwt$/.test(c.url))).toBe(true);
      const status = (await adapter.invokeSkill('settings_card', { inputs: { stage: 'status' } })).data as {
        odlab: { ak: { configured: boolean; fingerprint: string }; sk: { configured: boolean } };
      };
      expect(status.odlab.ak.configured).toBe(true);
      expect(status.odlab.ak.fingerprint).toBe('…0001');
      expect(status.odlab.sk.configured).toBe(true);
    } finally {
      delete process.env.NANGYING_CONFIG_DIR;
      const { rmSync } = await import('node:fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
