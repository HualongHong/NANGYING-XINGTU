/**
 * 图像预处理（OCR 质量增强，适配层）。
 *
 * optional peer 策略：检测到 sharp 可用时做 EXIF 自动旋转 + 灰度 + 对比度拉伸（normalize）
 * + 小图 2x 放大；sharp 不可用时零依赖降级——仅 EXIF 方向检测并在 note 报告，
 * 不改变图像字节。sharp 为 optionalDependency，dynamic import + try/catch。
 */
import type { OcrEngine } from './localOcrDecoder.js';
import { parseExifOrientation } from './exifOrientation.js';

export interface PreprocessResult {
  data: Uint8Array;
  /** 实际应用的步骤标识（如 ['exif-rotate','grayscale+normalize','2x-upscale']） */
  applied: string[];
  /** 人类可读说明（进解码 note） */
  note: string;
}

export interface ImagePreprocessor {
  preprocess(image: Uint8Array): Promise<PreprocessResult>;
}

type SharpModule = typeof import('sharp');

let sharpCache: SharpModule | null | undefined;

async function loadSharp(): Promise<SharpModule | null> {
  if (sharpCache !== undefined) return sharpCache;
  try {
    const mod = (await import('sharp')) as { default?: SharpModule } & SharpModule;
    sharpCache = (mod.default ?? mod) as SharpModule;
  } catch {
    sharpCache = null;
  }
  return sharpCache;
}

const UPSCALE_MIN_WIDTH = 1000;

/** 创建预处理器（sharp 可用走增强管线，否则 EXIF 检测降级） */
export function createImagePreprocessor(): ImagePreprocessor {
  return {
    async preprocess(image: Uint8Array): Promise<PreprocessResult> {
      const orientation = parseExifOrientation(image);
      const sharp = await loadSharp();
      if (!sharp) {
        const rot = orientation !== undefined && orientation >= 5 && orientation <= 8;
        return {
          data: image,
          applied: [],
          note: rot
            ? `EXIF 方向 ${orientation}（未安装 sharp，未旋转/增强）`
            : '未安装 sharp，跳过预处理',
        };
      }
      try {
        const meta = await sharp(Buffer.from(image)).metadata();
        let img = sharp(Buffer.from(image)).rotate(); // EXIF 自动摆正
        const applied: string[] = ['exif-rotate'];
        img = img.grayscale().normalize();
        applied.push('grayscale+normalize');
        if ((meta.width ?? 0) > 0 && (meta.width ?? 0) < UPSCALE_MIN_WIDTH) {
          img = img.resize({ width: (meta.width ?? 0) * 2 });
          applied.push('2x-upscale');
        }
        const buf = await img.toBuffer();
        return { data: new Uint8Array(buf), applied, note: `sharp 预处理：${applied.join('、')}` };
      } catch {
        // 图像字节非法等：原样返回，由 OCR 引擎自行报错
        return { data: image, applied: [], note: 'sharp 预处理失败，原样传递' };
      }
    },
  };
}

/** 组装：预处理 + 识别，返回文本与合并 note（localOcrDecoder 两个图片路径复用） */
export async function recognizeWithPreprocess(
  engine: OcrEngine,
  preprocessor: ImagePreprocessor,
  image: Uint8Array,
  langs: string,
): Promise<{ text: string; note: string }> {
  const pp = await preprocessor.preprocess(image);
  const text = await engine.recognize(pp.data, langs);
  return { text, note: pp.note };
}
