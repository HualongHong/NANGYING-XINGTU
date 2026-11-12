/**
 * OpenDataLab 数据集 OpenAPI 客户端（端点与 AK/SK→JWT 流程复刻自官方 openxlab SDK 源码，
 * 见 adapters/odlab/README.md 平台矩阵；端点可经配置覆盖以兼容官方演进）。
 *
 * 降级设计（对应契约"平台政策"）：
 *  - 公共仓库匿名可探查（SDK 行为：list/info 对公开仓库无需授权）——无 AK/SK 也能用；
 *  - 受限仓库 401 → 抛 OdlabAuthError，执行器据其给"配置 AK/SK 命名密钥"引导；
 *  - AK/SK 仅用于 getJwt（HMAC 挑战签名），明文只出现在请求体与本机 secrets.json。
 */
import { createHmac } from 'node:crypto';
import { repoToApiName } from '../../core/dataset/inspectDataset.js';
import { redact, withTimeout } from '../core/decoders/shared.js';

const DEFAULT_ENDPOINT = 'https://openxlab.org.cn';
const DEFAULT_AUTH_BASE = 'https://openapi.openxlab.org.cn/api/v1/sso-be/api/v1/open/';
const DATASET_API = '/datasets/api/v2/';

/** 鉴权失败（401/无凭据访问受限仓库）：执行器据此输出配置引导 */
export class OdlabAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OdlabAuthError';
  }
}

export interface OdlabDatasetClientOptions {
  akProvider: () => string | undefined;
  skProvider: () => string | undefined;
  /** 数据集 API 基址（默认官方 endpoint，可经 settings extra.odlabEndpoint 覆盖） */
  endpoint?: string;
  /** AK/SK 换 JWT 的 OpenAPI 基址 */
  authBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ListFilesResult {
  /** 原始响应（防御性解包后的 data 部分），交由 core 归一化 */
  raw: unknown;
  nextCursor?: string;
}

export interface OdlabDatasetClient {
  /** 仓库元信息（公共仓库匿名可用） */
  info(repo: string): Promise<unknown>;
  /** 文件清单（recursive；公共仓库匿名可用） */
  listFiles(repo: string, opts: { prefix?: string; limit: number; after?: string }): Promise<ListFilesResult>;
}

interface CachedJwt {
  token: string;
  expiresAt: number;
}

export function createOdlabDatasetClient(opts: OdlabDatasetClientOptions): OdlabDatasetClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = (opts.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
  const authBase = (opts.authBase ?? DEFAULT_AUTH_BASE).replace(/\/$/, '') + '/';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let cached: CachedJwt | undefined;

  const secret = (): string => opts.skProvider()?.trim() ?? '';

  async function ensureJwt(): Promise<string | undefined> {
    const ak = opts.akProvider()?.trim();
    const sk = opts.skProvider()?.trim();
    if (!ak || !sk) return undefined;
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const authResp = await postJson<{ data?: { nonce?: string; algorithm?: string } }>(
      `${authBase}auth`, { ak }, false,
    );
    const nonce = authResp.data?.nonce;
    const algorithm = authResp.data?.algorithm ?? 'HmacSHA256';
    if (!nonce) throw new OdlabAuthError('OpenDataLab auth 挑战未返回 nonce（AK 可能无效）');
    const algo = algorithm.startsWith('Hmac') ? algorithm.slice(4) : algorithm;
    const d = createHmac(algo.toLowerCase(), sk).update(nonce).digest('base64');
    const jwtResp = await postJson<{ data?: Record<string, unknown> }>(
      `${authBase}getJwt`, { ak, d }, false,
    );
    const data = jwtResp.data ?? {};
    const token = pickStr(data, ['token', 'jwt', 'accessToken', 'access_token']);
    if (!token) throw new OdlabAuthError('OpenDataLab getJwt 未返回 token');
    const ttlMs = Number(pickStr(data, ['expiresIn', 'expires_in']) ?? '') || 30 * 60_000;
    cached = { token, expiresAt: Date.now() + ttlMs };
    return token;
  }

  async function authedHeaders(): Promise<Record<string, string> | undefined> {
    const token = await ensureJwt();
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  }

  async function getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
    let resp: Response;
    try {
      resp = await fetchImpl(url, { headers, signal: withTimeout(timeoutMs) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`OpenDataLab 请求失败：${redact(redact(msg, opts.akProvider()?.trim() ?? ''), secret())}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new OdlabAuthError(`OpenDataLab 访问受限（HTTP ${resp.status}）：该仓库可能非公开，请配置 odlabAccessKeyId/odlabSecretAccessKey 命名密钥`);
    }
    const raw = await resp.text().catch(() => '');
    if (!resp.ok) {
      throw new Error(`OpenDataLab HTTP ${resp.status}：${redact(raw.slice(0, 200), secret())}`);
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error('OpenDataLab 响应非法（非 JSON）');
    }
  }

  async function postJson<T>(url: string, body: unknown, _unused: boolean): Promise<T> {
    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: withTimeout(timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`OpenDataLab 鉴权请求失败：${redact(msg, secret())}`);
    }
    const raw = await resp.text().catch(() => '');
    if (!resp.ok) {
      throw new OdlabAuthError(`OpenDataLab 鉴权 HTTP ${resp.status}：${redact(raw.slice(0, 200), secret())}`);
    }
    return JSON.parse(raw) as T;
  }

  function unwrap(resp: unknown): Record<string, unknown> {
    if (typeof resp === 'object' && resp !== null && 'data' in (resp as Record<string, unknown>)) {
      const d = (resp as Record<string, unknown>).data;
      return typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {};
    }
    return typeof resp === 'object' && resp !== null ? (resp as Record<string, unknown>) : {};
  }

  return {
    async info(repo: string): Promise<unknown> {
      const name = encodeURIComponent(repoToApiName(repo));
      const url = `${endpoint}${DATASET_API}datasets/${name}`;
      try {
        return unwrap(await getJson(url));
      } catch (err) {
        if (err instanceof OdlabAuthError) {
          const headers = await authedHeaders();
          if (headers) return unwrap(await getJson(url, headers));
        }
        throw err;
      }
    },
    async listFiles(repo, { prefix, limit, after }): Promise<ListFilesResult> {
      const name = encodeURIComponent(repoToApiName(repo));
      const params = new URLSearchParams({ recursive: 'true', needContent: 'true', limit: String(limit) });
      if (prefix) params.set('prefix', prefix);
      if (after) params.set('after', after);
      const url = `${endpoint}${DATASET_API}datasets/${name}/r/main?${params.toString()}`;
      let data: Record<string, unknown>;
      try {
        data = unwrap(await getJson(url));
      } catch (err) {
        if (err instanceof OdlabAuthError) {
          const headers = await authedHeaders();
          if (headers) {
            data = unwrap(await getJson(url, headers));
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
      const nextCursor = pickStr(data, ['nextCursor', 'next_cursor', 'after']);
      return { raw: data, ...(nextCursor ? { nextCursor } : {}) };
    },
  };
}

function pickStr(root: unknown, keys: string[]): string | undefined {
  if (typeof root !== 'object' || root === null) return undefined;
  const r = root as Record<string, unknown>;
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}
