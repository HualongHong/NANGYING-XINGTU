/**
 * 扫描件结构化 OCR 管线（R5-1，反馈 a P0-3/N0）。
 *
 * 背景：7.46MB/13 页扫描 PDF 曾把 MCP stdio 服务打死（Connection closed，
 * 19 技能连带不可用）。本管线在解码层提供资源护栏：
 *   - 页数护栏：>60 页直接结构化报错（不硬解）；
 *   - 单 worker 复用：整册共用一个 tesseract worker（旧实现每页新建，开销巨大）；
 *   - 逐页并发限制：默认 2 页并行（pageConcurrency）；
 *   - 单页超时：默认 90s（超时不拖垮整册，该页记失败）；
 *   - 错误隔离：任何页级错误被捕获，全部失败才抛错——绝不使进程退出。
 *
 * 引擎可注入（engine?）以便测试 mock；缺省经 dynamic import 加载 tesseract.js，
 * 未安装时给中文安装指引。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcrEngine } from './localOcrDecoder.js';

/** 仓库根：源码（adapters/core/decoders → 3 层）与构建产物（dist/adapters/core/decoders → 4 层）双路径探测 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_CANDIDATES = [join(HERE, '../../..'), join(HERE, '../../../..')];

/** 语言包目录：优先 tessdata/（仓库内归宿），兼容旧部署回退仓库根；
 *  都没有则 null（回退 tesseract 默认缓存/CDN 行为） */
export function resolveOcrLangPath(): string | null {
  for (const root of REPO_ROOT_CANDIDATES) {
    if (existsSync(join(root, 'tessdata', 'chi_sim.traineddata'))) return join(root, 'tessdata');
  }
  for (const root of REPO_ROOT_CANDIDATES) {
    if (existsSync(join(root, 'chi_sim.traineddata'))) return root;
  }
  return null;
}

/** 扫描件 OCR 资源护栏默认值 */
export const OCR_MAX_PAGES = 60;
export const OCR_PAGE_TIMEOUT_MS = 90_000;
export const OCR_PAGE_CONCURRENCY = 2;
export const OCR_DEFAULT_LANGS = 'chi_sim+eng';

export const OCR_ENGINE_MISSING_HINT =
  '本地 OCR 需要安装 tesseract.js：pnpm add tesseract.js（语言包 chi_sim/eng 放 tessdata/ 目录，兼容仓库根）';

export interface SharedOcrEngine extends OcrEngine {
  /** 释放底层 worker（整册识别完成后调用） */
  close: () => Promise<void>;
}

/** 默认引擎：单 worker 复用（整册一次创建/销毁） */
export async function createSharedTesseractEngine(langs: string = OCR_DEFAULT_LANGS): Promise<SharedOcrEngine> {
  let mod: { createWorker?: (l: string | string[], oem?: number, options?: {
    langPath?: string; cacheMethod?: string; gzip?: boolean;
  }) => Promise<{
    recognize: (image: Uint8Array) => Promise<{ data: { text: string } }>;
    terminate: () => Promise<void>;
  }> };
  try {
    mod = (await import('tesseract.js')) as unknown as typeof mod;
  } catch {
    throw new Error(OCR_ENGINE_MISSING_HINT);
  }
  if (typeof mod.createWorker !== 'function') throw new Error(OCR_ENGINE_MISSING_HINT);
  const langList = langs.split('+').filter(Boolean);
  // 语言包在 tessdata/（兼容仓库根旧部署）：显式 langPath + 关缓存直读，
  // 否则 tesseract 走默认缓存/CDN 路径，离线环境会得到损坏的语言数据（乱码输出）。
  const langPath = resolveOcrLangPath();
  const worker = await mod.createWorker(
    langList.length === 1 ? langList[0] : langList,
    undefined,
    langPath ? { langPath, cacheMethod: 'none', gzip: false } : undefined,
  );
  return {
    async recognize(image: Uint8Array): Promise<string> {
      const { data } = await worker.recognize(image);
      return data.text;
    },
    async close(): Promise<void> {
      await worker.terminate();
    },
  };
}

export interface OcrPageResult {
  page: number;
  text: string;
  /** 该页是否识别超时/失败（text 可能为空） */
  failed: boolean;
}

export interface ScannedOcrResult {
  pages: OcrPageResult[];
  succeededPages: number;
  failedPages: number;
  elapsedMs: number;
  engine: string;
  language: string;
}

export interface ScannedOcrOptions {
  /** 注入引擎（测试 mock 用）；缺省创建共享 tesseract worker */
  engine?: SharedOcrEngine;
  langs?: string;
  /** 逐页并发（默认 2） */
  concurrency?: number;
  /** 单页超时（默认 90s） */
  pageTimeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${tag} 超时（${Math.round(ms / 1000)}s）`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/**
 * 逐页识别（并发受限 + 单页超时 + 错误隔离）。
 * 至少一页成功才返回；全部失败抛错（由调用方降级处理，绝不冒泡杀进程）。
 */
export async function ocrImages(
  images: Array<{ data: Uint8Array }>,
  opts: ScannedOcrOptions = {},
): Promise<ScannedOcrResult> {
  if (images.length === 0) throw new Error('没有可识别的页面图像');
  if (images.length > OCR_MAX_PAGES) {
    throw new Error(`扫描件页数 ${images.length} 超过 ${OCR_MAX_PAGES} 页上限：请按章节拆分 PDF 后逐份解析（或先用外部工具转文本）`);
  }
  const langs = opts.langs ?? OCR_DEFAULT_LANGS;
  const concurrency = Math.max(1, Math.min(4, opts.concurrency ?? OCR_PAGE_CONCURRENCY));
  const pageTimeoutMs = opts.pageTimeoutMs ?? OCR_PAGE_TIMEOUT_MS;
  const own = opts.engine ? null : await createSharedTesseractEngine(langs);
  const engine = opts.engine ?? own!;
  const t0 = Date.now();
  try {
    const results: OcrPageResult[] = new Array(images.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= images.length) return;
        try {
          const text = await withTimeout(
            engine.recognize(images[i].data, langs),
            pageTimeoutMs,
            `第${i + 1}页 OCR`,
          );
          results[i] = { page: i + 1, text: text.trim(), failed: false };
        } catch {
          results[i] = { page: i + 1, text: '', failed: true };
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const succeededPages = results.filter((r) => !r.failed).length;
    const failedPages = results.length - succeededPages;
    if (succeededPages === 0) {
      throw new Error(`OCR 全部 ${images.length} 页识别失败（引擎不可用或图像不可识别）：${OCR_ENGINE_MISSING_HINT}`);
    }
    return {
      pages: results,
      succeededPages,
      failedPages,
      elapsedMs: Date.now() - t0,
      engine: 'tesseract',
      language: langs,
    };
  } finally {
    if (own) {
      try { await own.close(); } catch { /* worker 终止失败不影响结果 */ }
    }
  }
}
