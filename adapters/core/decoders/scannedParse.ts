/**
 * 扫描件 PDF OCR 决策与执行（R5-1）：从"原始 PDF 字节 + ocr 选项"到
 * 分页文本或结构化错误。独立成模块以便注入 mock 引擎单测（不依赖真实 tesseract）。
 *
 * 判定顺序：
 *   非 PDF / ocr:false / 无图像 → skip（走既有解码链）
 *   页数 > 60 → error（结构化护栏报错，带拆分建议）
 *   ocr:true 或 ≥3 页图像（扫描件特征）→ ocrImages 逐页识别
 *   识别失败（引擎缺失/全页失败）→ error（调用方回落既有解码链并注明）
 */
import { extractPdfImages } from './pdfImageExtract.js';
import { ocrImages, OCR_MAX_PAGES, type ScannedOcrOptions, type SharedOcrEngine } from './scannedOcr.js';
import type { ParseOcrMeta } from '../../../core/nlp/parseCourseMaterial.js';

export type ScannedOcrOutcome =
  | { kind: 'decoded'; content: string; ocrMeta: ParseOcrMeta; failedPages: number }
  | { kind: 'error'; message: string; guard?: boolean }
  | { kind: 'skip' };

export async function tryScannedPdfOcr(
  data: Uint8Array,
  ocr: boolean | undefined,
  opts: ScannedOcrOptions = {},
): Promise<ScannedOcrOutcome> {
  if (ocr === false) return { kind: 'skip' };
  // R6-2：自动探测须"无实质文本层"——有文本层的 PDF（PPT/Word 导出，每页带背景图）
  // 走 OCR 只会对背景图识别出乱码；ocr:true 仍强制 OCR
  if (ocr !== true) {
    try {
      const { extractPdfText, PDF_TEXT_SUBSTANTIAL_CHARS } = await import('./pdfTextExtract.js');
      const text = extractPdfText(data);
      if (text && text.text.trim().length > PDF_TEXT_SUBSTANTIAL_CHARS) {
        return { kind: 'skip' };
      }
    } catch { /* 文本层解析失败不阻塞 OCR 探测 */ }
  }
  let images: ReturnType<typeof extractPdfImages>['images'];
  try {
    images = extractPdfImages(data).images;
  } catch {
    return { kind: 'skip' }; // 非法 PDF：交给既有解码链报错
  }
  if (images.length === 0) return { kind: 'skip' }; // 文本型 PDF：走正常通道
  if (images.length > OCR_MAX_PAGES) {
    return {
      kind: 'error',
      guard: true,
      message: `扫描件页数 ${images.length} 超过 ${OCR_MAX_PAGES} 页上限：请按章节拆分 PDF 后逐份解析，或用外部工具（如 pdftotext/OCRmyPDF）先转文本再传 content`,
    };
  }
  // ocr:true 强制；未显式给时 ≥3 页图像 = 页数多文本少的扫描件特征 → 自动探测
  if (ocr !== true && images.length < 3) return { kind: 'skip' };
  try {
    const r = await ocrImages(images.map((x) => ({ data: x.data })), opts);
    const content = r.pages.map((p) => `=== 第${p.page}页 ===\n${p.text}`).join('\n\n');
    return {
      kind: 'decoded',
      content,
      failedPages: r.failedPages,
      ocrMeta: {
        engine: r.engine,
        language: r.language,
        pages: images.length,
        elapsedMs: r.elapsedMs,
        auto: ocr !== true,
      },
    };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export type { SharedOcrEngine };
