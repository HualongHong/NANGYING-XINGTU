/**
 * 本地 OCR 解码器（默认文档解码通道）。
 *
 * pdf → pdfImageExtract 抽图 → tesseract 逐页识别（chi_sim+eng）→
 * 输出文本带 `=== 第N页 ===` 页标记；支持 pageRange 限定页区间。
 * 引擎经 dynamic import 加载：未安装 tesseract.js 时给中文提示，
 * 由调用方回退到宿主注入/配置的外部解码器。引擎可注入（engine?）以便测试 mock。
 */
import { resolveOcrLangPath } from './scannedOcr.js';
import type { DecodedDocument, DocumentDecoder } from '../../../core/decode/documentDecoder.js';
import { extractPdfImages } from './pdfImageExtract.js';
import { extractPptxImages, extractPptxText, toPagedText } from './pptxTextExtract.js';
import { orientationNeedsRotation, parseExifOrientation } from './exifOrientation.js';
import {
  createImagePreprocessor,
  recognizeWithPreprocess,
  type ImagePreprocessor,
} from './imagePreprocess.js';

/** OCR 引擎抽象（tesseract.js 适配层）。hints 可选（如 psm），向后兼容两参实现 */
export interface OcrEngine {
  recognize(image: Uint8Array, langs: string, hints?: Record<string, unknown>): Promise<string>;
}

export interface LocalOcrDecoderOptions {
  engine?: OcrEngine;
  langs?: string;
  /** 图像预处理器（默认 createImagePreprocessor：sharp 可用走增强管线，否则 EXIF 检测降级） */
  preprocessor?: ImagePreprocessor;
}

const ENGINE_MISSING_HINT =
  '本地 OCR 需要安装 tesseract.js（pnpm add tesseract.js），或改用宿主注入/配置的外部解码器';

async function loadDefaultEngine(): Promise<OcrEngine> {
  let mod: { createWorker?: (langs: string | string[], opts?: Record<string, unknown>) => Promise<{
    recognize: (image: Uint8Array) => Promise<{ data: { text: string } }>;
    terminate: () => Promise<void>;
  }> };
  try {
    mod = (await import('tesseract.js')) as unknown as typeof mod;
  } catch {
    throw new Error(ENGINE_MISSING_HINT);
  }
  if (typeof mod.createWorker !== 'function') throw new Error(ENGINE_MISSING_HINT);
  // 语言包在 tessdata/（兼容仓库根旧部署）：显式 langPath + 关缓存直读，
  // 否则 tesseract.js 默认按 CDN 路径拼接，本地语言包不被使用
  const langPath = resolveOcrLangPath();
  return {
    async recognize(image: Uint8Array, langs: string): Promise<string> {
      const langList = langs.split('+').filter(Boolean);
      const worker = await mod.createWorker!(
        langList.length === 1 ? langList[0] : langList,
        langPath ? { langPath, cacheMethod: 'none', gzip: false } : undefined,
      );
      try {
        const { data } = await worker.recognize(image);
        return data.text;
      } finally {
        await worker.terminate();
      }
    },
  };
}

export function createLocalOcrDecoder(opts: LocalOcrDecoderOptions = {}): DocumentDecoder {
  const langs = opts.langs ?? 'chi_sim+eng';
  const enginePromise: Promise<OcrEngine> | null = opts.engine ? Promise.resolve(opts.engine) : null;
  const preprocessor = opts.preprocessor ?? createImagePreprocessor();

  return {
    async decode(input: {
      data: Uint8Array;
      materialType: string;
      pageRange?: { from: number; to: number };
    }): Promise<DecodedDocument> {
      const mt = input.materialType.toLowerCase();
      const isPdf = mt === 'pdf';
      const isPptx = mt === 'pptx' || mt === 'ppt';

      // PPTX：原生文本优先；页内图片按 r:embed 顺序 OCR（[图k] 形态附在该页文本后）
      if (isPptx) {
        const result = extractPptxText(input.data);
        const { images: slideImages, skippedNonRaster } = extractPptxImages(input.data);
        const total = result.slides.reduce((n, s) => n + s.texts.length, 0);
        if (total === 0 && slideImages.length === 0) {
          throw new Error(
            `PPTX 无文本层且无可用光栅图片（${result.slides.length} 页，跳过非光栅 ${skippedNonRaster}），无法解码`,
          );
        }
        const pages: string[] = [];
        let engine: OcrEngine | null = null;
        let ocrCount = 0;
        let ocrFailed = 0;
        const ppNotes = new Set<string>();
        for (const slide of result.slides) {
          const parts: string[] = [slide.texts.join('\n\n')];
          for (const img of slideImages.filter((x) => x.page === slide.page)) {
            engine = engine ?? (await (enginePromise ?? loadDefaultEngine()));
            try {
              const { text, note: ppNote } = await recognizeWithPreprocess(
                engine, preprocessor, img.data, langs,
              );
              ppNotes.add(ppNote);
              ocrCount += 1;
              if (text.trim()) parts.push(`[图${img.index}] ${text.trim()}`);
            } catch {
              ocrFailed += 1; // 单图失败不拖垮整册（损坏图/罕见编码等）
            }
          }
          const notes = slide.notes.length > 0 ? `\n[备注] ${slide.notes.join(' ')}` : '';
          pages.push(`=== 第${slide.page}页 ===\n${parts.filter(Boolean).join('\n\n')}${notes}`);
        }
        const pureImage = result.slides.filter((s) => s.texts.length === 0).length;
        const ppNote = [...ppNotes].join('；');
        const skipNote = skippedNonRaster + ocrFailed > 0
          ? `，跳过非光栅 ${skippedNonRaster}、识别失败 ${ocrFailed}`
          : '';
        const note = ocrCount > 0
          ? `PPTX 原生文本 + 图片 OCR（${ocrCount} 张图${pureImage ? `，${pureImage} 页纯图片` : ''}${skipNote}；${ppNote}）`
          : `PPTX 原生文本（无 OCR${skipNote}）`;
        return { content: pages.join('\n\n'), materialType: input.materialType, note };
      }

      if (!isPdf) {
        // 单张图片：预处理（EXIF 旋转/增强或降级报告）+ 识别
        const engine = await (enginePromise ?? loadDefaultEngine());
        const orientation = parseExifOrientation(input.data);
        const { text, note: ppNote } = await recognizeWithPreprocess(
          engine, preprocessor, input.data, langs,
        );
        const rotateNote = orientationNeedsRotation(orientation)
          ? `（EXIF 方向 ${orientation}）`
          : '';
        return {
          content: `=== 第1页 ===\n${text}`,
          materialType: input.materialType,
          note: `本地 OCR${rotateNote}；${ppNote}`,
        };
      }

      const { images, skipped } = extractPdfImages(input.data);
      if (images.length === 0) {
        throw new Error(`PDF 中未抽取到可识别图像（跳过 ${skipped} 个不支持的图像对象）`);
      }
      const engine = await (enginePromise ?? loadDefaultEngine()); // 未装 tesseract.js 时抛中文提示
      const from = input.pageRange?.from ?? 1;
      const to = Math.min(input.pageRange?.to ?? images.length, images.length);
      const parts: string[] = [];
      for (let page = from; page <= to; page++) {
        const { text, note: ppNote } = await recognizeWithPreprocess(
          engine, preprocessor, images[page - 1].data, langs,
        );
        parts.push(`=== 第${page}页 ===\n${text.trim()}`);
        if (page === from && ppNote) parts.push(`[预处理] ${ppNote}`);
      }
      const note = skipped > 0 ? `本地 OCR（跳过 ${skipped} 个不支持的图像对象）` : '本地 OCR';
      return {
        content: parts.join('\n\n'),
        materialType: input.materialType,
        note,
      };
    },
  };
}
