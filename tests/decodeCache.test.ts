import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeCacheKey,
  readDecodeCache,
  writeDecodeCache,
  DECODER_VERSION,
} from '../adapters/core/decoders/cache.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import { registerSharedSkills } from '../adapters/core/executors.js';
import type { DocumentDecoder } from '../core/decode/documentDecoder.js';

const dirs: string[] = [];
const savedEnv = process.env.NANGYING_CONFIG_DIR;
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.NANGYING_CONFIG_DIR;
  else process.env.NANGYING_CONFIG_DIR = savedEnv;
});

function useTempConfigDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'nangying-cache-'));
  dirs.push(d);
  process.env.NANGYING_CONFIG_DIR = d;
  return d;
}

describe('解码缓存', () => {
  it('键含 materialType/版本/内容哈希，确定性', () => {
    const data = new Uint8Array([1, 2, 3]);
    const k1 = decodeCacheKey(data, 'pptx');
    const k2 = decodeCacheKey(new Uint8Array([1, 2, 3]), 'pptx');
    expect(k1).toBe(k2);
    expect(k1).toContain('pptx');
    expect(k1).toContain(DECODER_VERSION);
    expect(decodeCacheKey(data, 'pdf')).not.toBe(k1);
    expect(decodeCacheKey(new Uint8Array([9]), 'pptx')).not.toBe(k1);
  });

  it('写读往返；缺失返回 undefined', () => {
    useTempConfigDir();
    const key = decodeCacheKey(new Uint8Array([5]), 'pdf');
    expect(readDecodeCache(key)).toBeUndefined();
    writeDecodeCache(key, '缓存的解码文本');
    expect(readDecodeCache(key)).toBe('缓存的解码文本');
  });

  it('端到端：第二次解码同文件 mock 引擎计数为 0', async () => {
    useTempConfigDir();
    let decodeCalls = 0;
    const mockDecoder: DocumentDecoder = {
      decode: async () => {
        decodeCalls += 1;
        return { content: '# 缓存命中的解码内容\n\n缓存段落。', materialType: 'pdf' };
      },
    };
    const adapter = new LocalAdapter();
    registerSharedSkills(adapter, { decoder: mockDecoder });
    // 二进制守卫必然触发的假 PDF
    const buf = Buffer.alloc(2048);
    buf.write('%PDF-1.4 fake', 0, 'ascii');
    buf.fill(0x00, 64);
    const inputs = {
      materialFile: { content: '占位', materialType: 'md' },
    };
    void inputs;
    const mkPdf = () => {
      const dir = mkdtempSync(join(tmpdir(), 'nangying-pdf-'));
      dirs.push(dir);
      const f = join(dir, 'doc.pdf');
      require('node:fs').writeFileSync(f, buf);
      return f;
    };
    const r1 = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: mkPdf() },
    });
    expect(r1.level).toBe('full');
    expect(decodeCalls).toBe(1);
    const r2 = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: mkPdf() },
    });
    expect(r2.level).toBe('full');
    expect(decodeCalls).toBe(1); // 缓存命中，引擎未被再次调用
    expect(JSON.stringify(r2.data)).toBe(JSON.stringify(r1.data));
  });
});
