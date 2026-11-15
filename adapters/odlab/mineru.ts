/**
 * MinerU（mineru.net）文档解码器。
 * 官方 API（2026-11 现行契约，https://mineru.net/apiManage/docs）：
 *
 * - 免费档（Agent 轻量解析）：签名上传三段式——
 *   ① POST /api/v1/agent/parse/file（JSON：file_name 等）→ { task_id, file_url }
 *   ② PUT 文件字节到 file_url（OSS 预签名，无 Authorization）
 *   ③ GET /api/v1/agent/parse/{task_id} 轮询 → done 得 markdown_url（CDN）→ 下载 Markdown。
 *   免 Token、IP 限频；≤10MB/20 页；仅 PDF/图片/Docx/PPTx/Xlsx。
 * - 精准档（v4）：单文件经批量上传通道——
 *   ① POST /api/v4/file-urls/batch（Bearer；JSON：files:[{name}]、model_version、language）
 *     → { batch_id, file_urls:[预签名 PUT URL] }（v4 /extract/task 仅收 URL 模式，不再接收 multipart 文件直传）
 *   ② PUT 文件字节到 file_urls[0]（系统自动扫描提交解析，无需再调创建接口）
 *   ③ GET /api/v4/extract-results/batch/{batch_id} 轮询 → extract_result[0].full_zip_url → 下载 zip 取 Markdown。
 *
 * 密钥经 keyProvider 惰性读取（不落日志）；无 Token 自动走免费档；任何失败由上层解码阶梯兜底。
 */
import { inflateSync } from 'node:zlib';
import type { DecoderConfig, DecodedDocument, DocumentDecoder } from '../../core/decode/documentDecoder.js';
import { redact, withTimeout } from '../core/decoders/shared.js';

export interface MinerUDecoderOptions {
  config: DecoderConfig;
  /** 请求时刻惰性读取 MinerU Token；不缓存、不打印。无 Token 时自动走免费档 */
  keyProvider: () => string | undefined;
  fetchImpl?: typeof fetch;
}

/** 免费档单文件上限（MinerU 官方口径：10MB） */
export const MINERU_FLASH_MAX_BYTES = 10 * 1024 * 1024;

const DEFAULT_BASE = 'https://mineru.net';
const POLL_INTERVAL_MS = 2000;
/** 精准档轮询总预算：默认 180s（MinerU 大文件解析分钟级） */
const PRECISE_BUDGET_MS = 180_000;

export function createMineruDecoder(opts: MinerUDecoderOptions): DocumentDecoder {
  const { config, keyProvider } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (config.endpoint ?? DEFAULT_BASE).replace(/\/$/, '');
  const backend = config.extra?.backend ?? 'pipeline';
  const timeoutMs = config.timeoutMs ?? 60_000;
  const budgetMs = Number(config.extra?.pollBudgetMs ?? PRECISE_BUDGET_MS) || PRECISE_BUDGET_MS;
  const pollIntervalMs = Number(config.extra?.pollIntervalMs ?? POLL_INTERVAL_MS) || POLL_INTERVAL_MS;

  return {
    async decode(input: { data: Uint8Array; materialType: string }): Promise<DecodedDocument> {
      const key = keyProvider()?.trim();
      if (key) {
        return decodePrecise(input, key);
      }
      return decodeFlash(input);
    },
  };

  // ---------- 免费档：Agent 轻量解析（签名上传三段式） ----------
  async function decodeFlash(input: { data: Uint8Array; materialType: string }): Promise<DecodedDocument> {
    if (input.data.byteLength > MINERU_FLASH_MAX_BYTES) {
      throw new Error(
        `MinerU 免费档单文件 ≤10MB（当前 ${(input.data.byteLength / 1048576).toFixed(1)}MB）；请改用精准档（配置 mineru Token）或本地 OCR`,
      );
    }
    const fileName = `document.${fileExt(input.materialType)}`;
    const created = await request(`${base}/api/v1/agent/parse/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_name: fileName, language: 'ch' }),
    });
    const taskId = pickString(created, ['data.task_id', 'task_id']);
    const uploadUrl = pickString(created, ['data.file_url', 'file_url']);
    if (taskId === undefined || uploadUrl === undefined) {
      throw new Error('MinerU 免费档未返回 task_id/file_url（签名上传契约变更？）');
    }
    await upload(uploadUrl, input.data, '');
    const markdownUrl = await pollAgentTask(taskId, '');
    const markdown = await downloadText(markdownUrl, '');
    return {
      content: markdown,
      materialType: input.materialType,
      note: `mineru flash（免费档免 Token；签名上传两段式，≤10MB/20 页，task=${taskId}）`,
    };
  }

  async function pollAgentTask(taskId: string, key: string): Promise<string> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`MinerU 免费档解析超时（>${Math.round(budgetMs / 1000)}s，task_id=${taskId}）`);
      }
      await sleep(pollIntervalMs);
      const st = await request(`${base}/api/v1/agent/parse/${encodeURIComponent(taskId)}`);
      const state = pickString(st, ['data.state', 'state']) ?? '';
      if (state === 'done') {
        const url = pickString(st, ['data.markdown_url', 'markdown_url']);
        if (!url) throw new Error('MinerU 免费档完成但无 markdown_url');
        return url;
      }
      if (state === 'failed' || state === 'error') {
        const msg = pickString(st, ['data.err_msg', 'err_msg', 'message']) ?? state;
        const code = pickScalar(st, ['data.err_code', 'err_code']);
        throw new Error(`MinerU 免费档解析失败${code !== undefined ? `（${code}）` : ''}：${msg}`);
      }
      // waiting-file / uploading / pending / running：继续轮询
    }
  }

  // ---------- 精准档：v4 批量上传通道（单文件 batch=1） ----------
  async function decodePrecise(
    input: { data: Uint8Array; materialType: string },
    key: string,
  ): Promise<DecodedDocument> {
    const fileName = `document.${fileExt(input.materialType)}`;
    const created = await request(`${base}/api/v4/file-urls/batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [{ name: fileName }],
        model_version: backend,
        language: 'ch',
      }),
    });
    const batchId = pickString(created, ['data.batch_id', 'batch_id']);
    const uploadUrls = pickStringArray(created, ['data.file_urls', 'file_urls']);
    if (batchId === undefined || uploadUrls === undefined || uploadUrls.length === 0) {
      throw new Error('MinerU 精准档未返回 batch_id/file_urls（批量上传契约变更？）');
    }
    await upload(uploadUrls[0], input.data, key);
    const zipUrl = await pollPreciseBatch(batchId, key);
    const zipBytes = await download(zipUrl, key);
    const md = extractMarkdownFromZip(zipBytes);
    if (md === undefined) throw new Error('MinerU zip 中未找到 Markdown 文件');
    return {
      content: md,
      materialType: input.materialType,
      note: `mineru precise（backend=${backend}，batch=${batchId}；zip 内含 Markdown+JSON）`,
    };
  }

  async function pollPreciseBatch(batchId: string, key: string): Promise<string> {
    const deadline = Date.now() + budgetMs;
    let lastState = '';
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`MinerU 精准档解析超时（>${Math.round(budgetMs / 1000)}s，batch_id=${batchId}）`);
      }
      await sleep(pollIntervalMs);
      const st = await request(`${base}/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
      });
      const results = pickArray(st, ['data.extract_result', 'extract_result']);
      const first = Array.isArray(results) && results.length > 0 && isObj(results[0]) ? (results[0] as Record<string, unknown>) : undefined;
      const state = pickString(first ?? null, ['state']) ?? '';
      lastState = state;
      if (state === 'done') {
        const zipUrl = pickString(first ?? null, ['full_zip_url', 'zip_url']);
        if (!zipUrl) throw new Error('MinerU 精准档完成但无 full_zip_url');
        return zipUrl;
      }
      if (state === 'failed' || state === 'error') {
        const msg = pickString(first ?? null, ['err_msg', 'message']) ?? lastState;
        throw new Error(`MinerU 精准档解析失败：${msg}`);
      }
      // waiting-file / pending / running / converting：继续轮询
    }
  }

  // ---------- HTTP 基础件 ----------
  async function request(url: string, init: RequestInit = {}): Promise<unknown> {
    const key = keyProvider()?.trim();
    let resp: Response;
    try {
      resp = await fetchImpl(url, { ...init, signal: withTimeout(timeoutMs) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`MinerU 请求失败：${redact(msg, key ?? '')}`);
    }
    const raw = await resp.text().catch(() => '');
    if (!resp.ok) {
      throw new Error(`MinerU HTTP ${resp.status}：${redact(raw.slice(0, 300), key ?? '')}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`MinerU 响应非法：${redact(raw.slice(0, 300), key ?? '')}`);
    }
    // 官方信封 { code, msg, data }：业务错误可能 HTTP 200 + code!=0
    if (isObj(body) && 'code' in body) {
      const code = (body as { code: unknown }).code;
      if (code !== 0 && code !== '0') {
        const msg = typeof (body as { msg?: unknown }).msg === 'string' ? ((body as { msg: string }).msg) : JSON.stringify(body).slice(0, 200);
        throw new Error(`MinerU 业务错误（code=${String(code)}）：${redact(msg, key ?? '')}`);
      }
    }
    return body;
  }

  /** 签名 URL 直传：PUT 原始字节（OSS 预签名，无须 Content-Type/Authorization） */
  async function upload(url: string, data: Uint8Array, key: string): Promise<void> {
    let resp: Response;
    try {
      resp = await fetchImpl(url, { method: 'PUT', body: data as unknown as BodyInit, signal: withTimeout(timeoutMs) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`MinerU 文件上传失败：${redact(msg, key)}`);
    }
    if (resp.status !== 200 && resp.status !== 201) {
      const raw = await resp.text().catch(() => '');
      throw new Error(`MinerU 文件上传 HTTP ${resp.status}：${redact(raw.slice(0, 200), key)}`);
    }
  }

  async function downloadText(url: string, key: string): Promise<string> {
    const bytes = await download(url, key);
    return Buffer.from(bytes).toString('utf8');
  }

  async function download(url: string, key: string): Promise<Uint8Array> {
    let resp: Response;
    try {
      resp = await fetchImpl(url, { signal: withTimeout(timeoutMs) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`MinerU 结果下载失败：${redact(msg, key)}`);
    }
    if (!resp.ok) {
      throw new Error(`MinerU 结果下载 HTTP ${resp.status}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** MinerU 支持的扩展名：解码链路由过来的 materialType 归一为小写扩展名 */
function fileExt(materialType: string): string {
  return materialType.replace(/^\./, '').toLowerCase();
}

/** 按路径候选从响应对象取字符串（官方字段口径可能演进，做防御性提取） */
function pickString(root: unknown, paths: string[]): string | undefined {
  for (const p of paths) {
    let cur: unknown = root;
    for (const seg of p.split('.')) {
      if (typeof cur !== 'object' || cur === null) { cur = undefined; break; }
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (typeof cur === 'string' && cur) return cur;
  }
  return undefined;
}

/** 取标量字段（字符串或数字，err_code 等） */
function pickScalar(root: unknown, paths: string[]): string | undefined {
  for (const p of paths) {
    let cur: unknown = root;
    for (const seg of p.split('.')) {
      if (typeof cur !== 'object' || cur === null) { cur = undefined; break; }
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (typeof cur === 'string' && cur) return cur;
    if (typeof cur === 'number') return String(cur);
  }
  return undefined;
}

/** 取字符串数组字段（file_urls 等） */
function pickStringArray(root: unknown, paths: string[]): string[] | undefined {
  for (const p of paths) {
    let cur: unknown = root;
    for (const seg of p.split('.')) {
      if (typeof cur !== 'object' || cur === null) { cur = undefined; break; }
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (Array.isArray(cur) && cur.every((x) => typeof x === 'string')) return cur as string[];
  }
  return undefined;
}

/** 取数组字段（extract_result 等） */
function pickArray(root: unknown, paths: string[]): unknown[] | undefined {
  for (const p of paths) {
    let cur: unknown = root;
    for (const seg of p.split('.')) {
      if (typeof cur !== 'object' || cur === null) { cur = undefined; break; }
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (Array.isArray(cur)) return cur;
  }
  return undefined;
}

/**
 * 从 MinerU 结果 zip 提取 Markdown：解析 zip 中央目录（EOCD→entries），
 * 优先 full.md，否则取体积最大的 .md；支持 stored(0) 与 deflate(8)。
 */
export function extractMarkdownFromZip(zip: Uint8Array): string | undefined {
  const buf = Buffer.from(zip);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buf.length) return undefined;
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const candidates: Array<{ name: string; size: number; localOffset: number; method: number }> = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) return undefined;
    const method = buf.readUInt16LE(offset + 10);
    const size = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (name.toLowerCase().endsWith('.md')) {
      candidates.push({ name, size, localOffset, method });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) =>
    a.name === 'full.md' ? -1 : b.name === 'full.md' ? 1 : b.size - a.size,
  );
  const pick = candidates[0];
  if (buf.readUInt32LE(pick.localOffset) !== 0x04034b50) return undefined;
  const nameLen = buf.readUInt16LE(pick.localOffset + 26);
  const extraLen = buf.readUInt16LE(pick.localOffset + 28);
  const dataStart = pick.localOffset + 30 + nameLen + extraLen;
  // size=0 容错（非规范 zip）：截取到下一个 PK 头或缓冲区末尾
  let dataEnd = dataStart + pick.size;
  if (pick.size === 0) {
    dataEnd = buf.length;
    for (let i = dataStart; i + 4 <= buf.length; i++) {
      const sig = buf.readUInt32LE(i);
      if (sig === 0x04034b50 || sig === 0x02014b50 || sig === 0x06054b50) { dataEnd = i; break; }
    }
  }
  const raw = buf.subarray(dataStart, dataEnd);
  try {
    const text = pick.method === 8 ? inflateSync(raw) : pick.method === 0 ? raw : undefined;
    return text === undefined ? undefined : text.toString('utf8');
  } catch {
    return undefined;
  }
}
