import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ny-parse-'));
  dirs.push(d);
  return d;
}

describe('parse_course_material 大文件守卫（反馈 P0-3：7.46MB 扫描件杀服务）', () => {
  it('二进制材料超 20MB：结构化中文报错（不进解码链、进程存活可继续调用）', async () => {
    const dir = tempDir();
    const bigPdf = join(dir, '扫描教材.pdf');
    writeFileSync(bigPdf, Buffer.alloc(21 * 1024 * 1024, 0)); // >20MB 伪 PDF（全 \x00，必判二进制）

    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: bigPdf },
    });
    expect(r.level).toBe('unavailable');
    expect(r.errorCode).toBe('INVALID_INPUT');
    expect(r.degradationNote).toContain('20 MB');
    expect(r.degradationNote).toContain('async:true');

    // 服务未崩：后续调用照常
    const ok = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: { content: '# 标题\n\n内容。', materialType: 'md' } },
    });
    expect(ok.level).toBe('full');
  }, 30000);

  it('20MB 内的二进制材料不被守卫拦截（正常进入解码链）', async () => {
    const dir = tempDir();
    const smallPdf = join(dir, 'small.pdf');
    writeFileSync(smallPdf, Buffer.alloc(1024, 0)); // 1KB 伪 PDF：解码链全失败 → 降级而非「文件过大」
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: smallPdf },
    });
    expect(r.degradationNote).not.toContain('20 MB');
    expect(['degraded', 'full']).toContain(r.level);
  }, 30000);
});

describe('parse_course_material 路径解析（反馈 P0：相对路径按插件 cwd 解析 ENOENT）', () => {
  it('workspaceRoot：相对路径优先相对它解析（MCP 子进程 cwd 与宿主工作区不一致时可用）', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '提纲.md'), '# 课时提纲\n\n种群密度与分布格局。');
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: '提纲.md', workspaceRoot: dir },
    });
    expect(r.level).toBe('full');
    const data = r.data as { paragraphs: Array<{ text: string }> };
    expect(data.paragraphs.some((p) => p.text.includes('种群密度'))).toBe(true);
  });

  it('ENOENT：回显解析后的绝对路径 + workspaceRoot 中文引导', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: '不存在的文件_xyz.md' },
    });
    expect(r.level).toBe('unavailable');
    expect(r.errorCode).toBe('INVALID_INPUT');
    expect(r.degradationNote).toContain('不存在的文件_xyz.md');
    expect(r.degradationNote).toContain('绝对路径');
    expect(r.degradationNote).toContain('workspaceRoot');
  });

  it('相对路径 + workspaceRoot：报错回显拼接后的绝对路径', async () => {
    const dir = tempDir();
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: '缺失.md', workspaceRoot: dir },
    });
    expect(r.level).toBe('unavailable');
    expect(r.degradationNote).toContain(resolve(join(dir, '缺失.md')));
  });
});
