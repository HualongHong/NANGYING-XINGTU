/**
 * MinerU 云端解析解码器（OpenDataLab 体系）：表格→HTML、公式→LaTeX、扫描件高精度 OCR。
 * 双模式（provider 配置 provider="mineru"，密钥可选）：
 *  - 有 Token：精准档 POST /api/v4/extract/task（异步任务→轮询→zip，≤200MB）；
 *  - 无 Token：免费档 POST /api/v1/agent/parse/file（≤10MB/20 页，仅 Markdown，IP 限频）。
 * 密钥经 keyProvider 惰性读取；错误消息 redact 脱敏；与 kimi/openai 解码器同契约。
 * 平台不可用时抛错——解码阶梯会自动回落本地链路（独立性保证）。
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

  async function decodeFlash(input: { data: Uint8Array; materialType: string }): Promise<DecodedDocument> {
    if (input.data.byteLength > MINERU_FLASH_MAX_BYTES) {
      throw new Error(
        `MinerU 免费档单文件 ≤10MB（当前 ${(input.data.byteLength / 1048576).toFixed(1)}MB）；请改用精准档（配置 mineru Token）或本地 OCR`,
      );
    }
    const form = new FormData();
    form.append('file', new Blob([input.data as BlobPart]), `document.${input.materialType}`);
    const resp = await request(`${base}/api/v1/agent/parse/file`, { method: 'POST', body: form });
    const markdown = pickString(resp, ['data.markdown_content', 'data.markdown', 'data.text', 'markdown']);
    if (markdown === undefined) {
      throw new Error('MinerU 免费档响应缺少 Markdown 字段');
    }
    return {
      content: markdown,
      materialType: input.materialType,
      note: 'mineru flash（免费档，免 Token；≤10MB/20 页，以官网口径为准）',
    };
  }

  async function decodePrecise(
    input: { data: Uint8Array; materialType: string },
    key: string,
  ): Promise<DecodedDocument> {
    const form = new FormData();
    form.append('file', new Blob([input.data as BlobPart]), `document.${input.materialType}`);
    form.append('lang', 'ch');
    form.append('backend', backend);
    const created = await request(`${base}/api/v4/extract/task`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const taskId = pickString(created, ['data.task_id', 'task_id']);
    if (taskId === undefined) {
      throw new Error('MinerU 精准档未返回 task_id');
    }
    const deadline = Date.now() + budgetMs;
    let lastState = '';
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`MinerU 精准档解析超时（>${Math.round(budgetMs / 1000)}s，task_id=${taskId}）`);
      }
      await sleep(pollIntervalMs);
      const st = await request(`${base}/api/v4/extract/task/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
      });
      const state = pickString(st, ['data.state', 'state']) ?? '';
      lastState = state;
      if (state === 'done') {
        const zipUrl = pickString(st, ['data.zip_url', 'data.full_zip_url', 'zip_url']);
        if (!zipUrl) throw new Error('MinerU 精准档完成但无 zip_url');
        const zipBytes = await download(zipUrl, key);
        const md = extractMarkdownFromZip(zipBytes);
        if (md === undefined) throw new Error('MinerU zip 中未找到 Markdown 文件');
        return {
          content: md,
          materialType: input.materialType,
          note: `mineru precise（backend=${backend}，task=${taskId}；zip 内含 Markdown+JSON）`,
        };
      }
      if (state === 'failed' || state === 'error') {
        const msg = pickString(st, ['data.err_msg', 'data.message', 'message']) ?? lastState;
        throw new Error(`MinerU 精准档解析失败：${msg}`);
      }
    }
  }

  async function request(url: string, init: RequestInit): Promise<unknown> {
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
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`MinerU 响应非法：${redact(raw.slice(0, 300), key ?? '')}`);
    }
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
