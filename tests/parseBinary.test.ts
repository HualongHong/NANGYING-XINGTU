import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import { registerSharedSkills } from '../adapters/core/executors.js';
import { writeConfig, writeApiKey } from '../adapters/core/configStore.js';
import type { ParseCourseMaterialOutput } from '../core/nlp/parseCourseMaterial.js';
import type { DocumentDecoder } from '../core/decode/documentDecoder.js';

const dirs: string[] = [];
const savedEnv = process.env.NANGYING_CONFIG_DIR;
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.NANGYING_CONFIG_DIR;
  else process.env.NANGYING_CONFIG_DIR = savedEnv;
});

/** 最小假 PDF：%PDF 头 + 大量 \x00（必然触发二进制守卫） */
function fakePdf(): Buffer {
  const buf = Buffer.alloc(2048);
  buf.write('%PDF-1.4 fake', 0, 'ascii');
  buf.fill(0x00, 64);
  return buf;
}

function tempPdf(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nangying-pdf-'));
  dirs.push(dir);
  const file = join(dir, 'lecture.pdf');
  writeFileSync(file, fakePdf());
  return file;
}

describe('parse 二进制文档解码链', () => {
  it('① 宿主注入 ctx.decoder → full，内容为解码文本', async () => {
    const adapter = new LocalAdapter();
    const mockDecoder: DocumentDecoder = {
      decode: async () => ({ content: '# 解码出的章节\n\n解码出的段落。', materialType: 'pdf', note: 'mock' }),
    };
    registerSharedSkills(adapter, { decoder: mockDecoder });
    const result = await adapter.invokeSkill<ParseCourseMaterialOutput>('parse_course_material', {
      inputs: { materialFile: tempPdf() },
    });
    expect(result.level).toBe('full');
    expect(result.data!.paragraphs.some((p: { text: string }) => p.text.includes('解码出的段落'))).toBe(true);
  });

  it('③ 无 decoder 且无配置 → degraded + 中文说明 + 尽力提取数据', async () => {
    const adapter = new LocalAdapter();
    process.env.NANGYING_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'nangying-empty-'));
    dirs.push(process.env.NANGYING_CONFIG_DIR);
    const result = await adapter.invokeSkill<ParseCourseMaterialOutput>('parse_course_material', {
      inputs: { materialFile: tempPdf() },
    });
    expect(result.level).toBe('degraded');
    expect(result.degradationNote).toContain('二进制文档');
    expect(result.degradationNote).toContain('解码引擎');
    expect(result.data!.paragraphs.length).toBeGreaterThan(0);
  });

  it('② 配置解码器（settings+假 key，stub 全局 fetch）→ full', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nangying-cfg-'));
    dirs.push(dir);
    process.env.NANGYING_CONFIG_DIR = dir;
    writeConfig({ provider: 'kimi', model: 'm1', endpoint: 'https://api.moonshot.cn' });
    writeApiKey('test-key-xxx');

    // stub 全局 fetch，避免真实网络请求
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ content: '# 配置解码的章节\n\n配置解码的段落。' }), { status: 200 })) as typeof fetch;
    try {
      const adapter = new LocalAdapter();
      const result = await adapter.invokeSkill<ParseCourseMaterialOutput>('parse_course_material', {
        inputs: { materialFile: tempPdf() },
      });
      expect(result.level).toBe('full');
      expect(
        result.data!.paragraphs.some((p: { text: string }) => p.text.includes('配置解码的段落')),
      ).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('① 优先于 ②：同时注入 decoder 与配置时走宿主注入', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nangying-cfg2-'));
    dirs.push(dir);
    process.env.NANGYING_CONFIG_DIR = dir;
    writeConfig({ provider: 'kimi' });
    writeApiKey('test-key-xxx');
    const adapter = new LocalAdapter();
    const mockDecoder: DocumentDecoder = {
      decode: async () => ({ content: '# 宿主注入的章节\n\n宿主注入的解码内容。', materialType: 'pdf' }),
    };
    let configDecoderCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      configDecoderCalled = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      registerSharedSkills(adapter, { decoder: mockDecoder });
      const result = await adapter.invokeSkill<ParseCourseMaterialOutput>('parse_course_material', {
        inputs: { materialFile: tempPdf() },
      });
      expect(result.level).toBe('full');
      expect(
        result.data!.paragraphs.some((p: { text: string }) => p.text.includes('宿主注入')),
      ).toBe(true);
      expect(configDecoderCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
