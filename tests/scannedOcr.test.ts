import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ocrImages,
  OCR_MAX_PAGES,
  OCR_PAGE_CONCURRENCY,
  type SharedOcrEngine,
} from '../adapters/core/decoders/scannedOcr.js';
import { tryScannedPdfOcr } from '../adapters/core/decoders/scannedParse.js';
import { parseCourseMaterial } from '../core/nlp/parseCourseMaterial.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** mock 引擎：可配置每页行为/耗时，记录并发峰值（不加载真实 tesseract） */
function mockEngine(behavior: (page: number) => Promise<string> | Promise<never>): SharedOcrEngine & { maxInFlight: number; calls: number[] } {
  let inFlight = 0;
  const tracker = {
    maxInFlight: 0,
    calls: [] as number[],
    recognize: (async (_img: Uint8Array, _langs: string) => {
      tracker.calls.push(1);
      inFlight += 1;
      tracker.maxInFlight = Math.max(tracker.maxInFlight, inFlight);
      try {
        const page = tracker.calls.length;
        return await behavior(page);
      } finally {
        inFlight -= 1;
      }
    }) as SharedOcrEngine['recognize'],
    close: async () => {},
  };
  return tracker;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const images = (n: number) => Array.from({ length: n }, () => ({ data: new Uint8Array([0xff, 0xd8, 1, 2, 3]) }));

/** 合成扫描件 PDF：pdfImageExtract 直接扫描 stream 块，无需 xref */
function fakeScannedPdf(pageCount: number): Uint8Array {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9]);
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  for (let i = 0; i < pageCount; i++) {
    parts.push(
      Buffer.from(`\n<< /Subtype /Image /Filter /DCTDecode /Width 10 /Height 10 /Length ${jpeg.length} >>\nstream\n`),
      jpeg,
      Buffer.from('\nendstream\n'),
    );
  }
  parts.push(Buffer.from('%%EOF\n'));
  return new Uint8Array(Buffer.concat(parts));
}

describe('R5-1 scannedOcr 管线（mock 引擎；全链路真实 OCR 不在 CI 跑）', () => {
  it('逐页并发受限：6 页 × 并发 2，引擎并发峰值 ≤2', async () => {
    const engine = mockEngine(async () => { await sleep(20); return '页文本'; });
    const r = await ocrImages(images(6), { engine, concurrency: OCR_PAGE_CONCURRENCY });
    expect(r.succeededPages).toBe(6);
    expect(engine.maxInFlight).toBeLessThanOrEqual(2);
    expect(r.pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.engine).toBe('tesseract');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('错误隔离：单页抛错不拖垮整册；全部失败才抛错', async () => {
    const engine = mockEngine(async (page) => {
      if (page === 2) throw new Error('该页损坏');
      return `第${page}页内容`;
    });
    const r = await ocrImages(images(4), { engine });
    expect(r.succeededPages).toBe(3);
    expect(r.failedPages).toBe(1);
    expect(r.pages[1].failed).toBe(true);
    expect(r.pages[0].text).toBe('第1页内容');

    const allBad = mockEngine(async () => { throw new Error('x'); });
    await expect(ocrImages(images(3), { engine: allBad }))
      .rejects.toThrow('全部 3 页识别失败');
  });

  it('单页超时：挂起页记失败，其余页照常', async () => {
    const engine = mockEngine(async (page) => {
      if (page === 2) return new Promise<string>(() => {}); // 永不返回
      return 'ok';
    });
    const r = await ocrImages(images(3), { engine, pageTimeoutMs: 100 });
    expect(r.failedPages).toBe(1);
    expect(r.pages[1].failed).toBe(true);
    expect(r.succeededPages).toBe(2);
  }, 10000);

  it('页数护栏：>60 页直接抛错（不进入识别）', async () => {
    const engine = mockEngine(async () => 'x');
    await expect(ocrImages(images(OCR_MAX_PAGES + 1), { engine }))
      .rejects.toThrow(`超过 ${OCR_MAX_PAGES} 页上限`);
    expect(engine.calls.length).toBe(0); // 护栏先行，引擎未被调用
  });
});

describe('R5-1 扫描件决策（tryScannedPdfOcr，合成扫描件夹具）', () => {
  it('ocr:true 强制识别：mock 引擎产出分页文本与 meta（auto:false）', async () => {
    const engine = mockEngine(async (page) => `水质分析第${page}页`);
    const r = await tryScannedPdfOcr(fakeScannedPdf(3), true, { engine });
    expect(r.kind).toBe('decoded');
    if (r.kind !== 'decoded') return;
    expect(r.content).toContain('=== 第1页 ===');
    expect(r.content).toContain('=== 第3页 ===');
    expect(r.content).toContain('水质分析第2页');
    expect(r.ocrMeta).toMatchObject({ engine: 'tesseract', language: 'chi_sim+eng', pages: 3, auto: false });
  });

  it('自动探测：≥3 页图像且 ocr 未显式给 → 自动 OCR（auto:true）', async () => {
    const engine = mockEngine(async () => '文本');
    const r = await tryScannedPdfOcr(fakeScannedPdf(3), undefined, { engine });
    expect(r.kind).toBe('decoded');
    if (r.kind === 'decoded') expect(r.ocrMeta.auto).toBe(true);
  });

  it('ocr:false 或图像 <3 页 → skip（走既有解码链）', async () => {
    const engine = mockEngine(async () => 'x');
    expect((await tryScannedPdfOcr(fakeScannedPdf(5), false, { engine })).kind).toBe('skip');
    expect((await tryScannedPdfOcr(fakeScannedPdf(2), undefined, { engine })).kind).toBe('skip');
    expect(engine.calls.length).toBe(0);
  });

  it('页数护栏：61 页扫描件 → guard 错误（结构化，不识别）', async () => {
    const r = await tryScannedPdfOcr(fakeScannedPdf(OCR_MAX_PAGES + 1), true);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.guard).toBe(true);
      expect(r.message).toContain('60 页上限');
    }
  });

  it('引擎失败 → error（调用方回落，不抛异常杀进程）', async () => {
    const engine = mockEngine(async () => { throw new Error('引擎不可用'); });
    const r = await tryScannedPdfOcr(fakeScannedPdf(3), true, { engine });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('识别失败');
  });
});

describe('R5-1 页锚点与护栏（真跑，无 mock）', () => {
  it('分页标记 → 段落/表格带 page；annotateSource → source:"ocr"；meta 可附着', async () => {
    const content = '=== 第1页 ===\n种群密度是数量特征。\n\n=== 第2页 ===\n| 指标 | 含义 |\n| --- | --- |\n| 密度 | 个体数 |\n\n标志重捕法用于调查。';
    const r = await parseCourseMaterial(
      { content, materialType: 'txt', options: { annotateSource: 'ocr' } },
    );
    const p1 = r.data!.paragraphs.find((p) => p.text.includes('种群密度'))!;
    expect(p1.page).toBe(1);
    expect(p1.source).toBe('ocr');
    const p2 = r.data!.paragraphs.find((p) => p.text.includes('标志重捕法'))!;
    expect(p2.page).toBe(2);
    expect(r.data!.tables[0].page).toBe(2);
    expect(r.data!.tables[0].source).toBe('ocr');
    // 标记行不进正文
    expect(r.data!.paragraphs.some((p) => p.text.includes('==='))).toBe(false);
  });

  it('>60 页扫描件经适配层：结构化 INVALID_INPUT，进程存活可续调', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ny-guard-'));
    dirs.push(dir);
    const pdfPath = join(dir, '大扫描件.pdf');
    writeFileSync(pdfPath, fakeScannedPdf(OCR_MAX_PAGES + 1));
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: pdfPath, ocr: true },
    });
    expect(r.level).toBe('unavailable');
    expect(r.errorCode).toBe('INVALID_INPUT');
    expect(r.degradationNote).toContain('60 页上限');
    // 进程未死：后续调用照常
    const ok = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: { content: '# 标题\n\n内容。', materialType: 'md' } },
    });
    expect(ok.level).toBe('full');
  }, 30000);
});

describe('resolveOcrLangPath：语言包目录探测', () => {
  it('在真实仓库中优先解析到 tessdata/（chi_sim.traineddata 所在目录）', async () => {
    const { resolveOcrLangPath } = await import('../adapters/core/decoders/scannedOcr.js');
    const langPath = resolveOcrLangPath();
    expect(langPath).not.toBeNull();
    expect(langPath!.endsWith('tessdata')).toBe(true);
    expect(existsSync(join(langPath!, 'chi_sim.traineddata'))).toBe(true);
    // 回退语义：tessdata/ 缺失时仍兼容仓库根旧部署（本仓库已迁 tessdata/，此处验证目录语义）
  });
});
