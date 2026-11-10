import { describe, expect, it, vi } from 'vitest';
import {
  createImagePreprocessor,
  recognizeWithPreprocess,
  type ImagePreprocessor,
} from '../adapters/core/decoders/imagePreprocess.js';
import { createLocalOcrDecoder, type OcrEngine } from '../adapters/core/decoders/localOcrDecoder.js';

const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xd9]);

describe('图像预处理管线', () => {
  it('mock 预处理器：识别收到预处理后字节，note 透传（管线顺序：先预处理后识别）', async () => {
    const calls: string[] = [];
    const preprocessor: ImagePreprocessor = {
      preprocess: async (img) => {
        calls.push(`preprocess:${img.length}`);
        return { data: new Uint8Array([9, 9]), applied: ['mock-pp'], note: 'mock 预处理' };
      },
    };
    const engine: OcrEngine = {
      recognize: async (img) => {
        calls.push(`recognize:${img.length}`);
        return '文字';
      },
    };
    const r = await recognizeWithPreprocess(engine, preprocessor, FAKE_JPEG, 'eng');
    expect(r.text).toBe('文字');
    expect(r.note).toBe('mock 预处理');
    expect(calls).toEqual([`preprocess:${FAKE_JPEG.length}`, 'recognize:2']);
  });

  it('localOcrDecoder 图片路径接入预处理器（注入 mock，note 含预处理说明）', async () => {
    const preprocessor: ImagePreprocessor = {
      preprocess: async (img) => ({
        data: img, applied: ['mock-pp'], note: 'mock 预处理（测试）',
      }),
    };
    const decoder = createLocalOcrDecoder({
      engine: { recognize: async () => '图片文字' },
      preprocessor,
    });
    const doc = await decoder.decode({ data: FAKE_JPEG, materialType: 'image' });
    expect(doc.content).toContain('图片文字');
    expect(doc.note).toContain('mock 预处理（测试）');
    expect(doc.note).toContain('本地 OCR');
  });

  it('PPTX 图片 OCR 路径同样接入预处理', async () => {
    const pp = vi.fn(async (img: Uint8Array) => ({
      data: img, applied: ['mock'], note: 'mock 预处理',
    }));
    const decoder = createLocalOcrDecoder({
      engine: { recognize: async () => '图文字' },
      preprocessor: { preprocess: pp },
    });
    // 复用 pptxImageOcr 的最小课件结构：直接构造含图幻灯片
    const { zipWithOneImage } = await import('./helpers/miniPptx.js');
    const doc = await decoder.decode({ data: zipWithOneImage(), materialType: 'pptx' });
    expect(pp).toHaveBeenCalled();
    expect(doc.note).toContain('mock 预处理');
  });

  it('createImagePreprocessor：无论 sharp 是否可用都返回合法结果对象', async () => {
    const preprocessor = createImagePreprocessor();
    const r = await preprocessor.preprocess(FAKE_JPEG);
    expect(typeof r.note).toBe('string');
    expect(r.note.length).toBeGreaterThan(0);
    expect(Array.isArray(r.applied)).toBe(true);
    expect(r.data.length).toBeGreaterThan(0);
    // 降级路径字节不变（FAKE_JPEG 无 EXIF 旋转需求；若 sharp 已装则走增强管线）
    if (r.note.includes('未安装 sharp')) {
      expect(r.data).toEqual(FAKE_JPEG);
    } else {
      expect(r.note).toContain('sharp 预处理');
    }
  });
});
