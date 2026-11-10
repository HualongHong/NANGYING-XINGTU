import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDocxText } from '../adapters/core/decoders/docxTextExtract.js';
import { buildMiniZip } from './helpers/miniPptx.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

/** 内存构造最小 docx：word/document.xml 含标题段落、正文段落与一张表格 */
function buildMiniDocx(): Uint8Array {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>第一章 种群生态学</w:t></w:r></w:p>
<w:p><w:r><w:t>种群是同一物种个体的集合，种群密度是种群最基本的数量特征。</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>含义</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>种群密度</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>单位面积个体数</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body>
</w:document>`;
  return new Uint8Array(buildMiniZip([
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]));
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('docx 原生文本抽取（零依赖 zip → word/document.xml）', () => {
  it('段落一行、表格逐行「 | 」分隔，保留文档结构', () => {
    const text = extractDocxText(buildMiniDocx());
    expect(text).toContain('第一章 种群生态学');
    expect(text).toContain('种群是同一物种个体的集合');
    expect(text).toContain('指标 | 含义');
    expect(text).toContain('种群密度 | 单位面积个体数');
    // 段落与表格分行
    expect(text.split('\n').length).toBeGreaterThanOrEqual(4);
  });

  it('run 拼接：跨 run 的中文词不被拆散', () => {
    const xml = `<w:document><w:body>` +
      `<w:p><w:r><w:t>Morisita</w:t></w:r><w:r><w:t>指数</w:t></w:r></w:p>` +
      `</w:body></w:document>`;
    const docx = new Uint8Array(buildMiniZip([
      { name: 'word/document.xml', data: Buffer.from(xml, 'utf8') },
    ]));
    expect(extractDocxText(docx)).toBe('Morisita指数');
  });

  it('非 docx（缺 word/document.xml）抛错，由调用方降级 OCR 链', () => {
    const bad = new Uint8Array(buildMiniZip([
      { name: 'ppt/slides/slide1.xml', data: Buffer.from('<p:sld/>') },
    ]));
    expect(() => extractDocxText(bad)).toThrow('word/document.xml');
  });
});

describe('parse_course_material 走 docx 原生文本链（反馈 P0-3：docx 曾 Connection closed）', () => {
  it('纯文本 docx 走原生抽取返回 full，不碰 OCR 解码链（反馈 P0-3：docx 曾 Connection closed）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ny-docx-'));
    dirs.push(dir);
    // 模拟真实讲义体量：伪随机内容（deflate 不可压）撑到 ~200KB docx
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const pad = Array.from({ length: 6000 }, () =>
      `第${rand() % 97}节 知识点${rand().toString(16)}${rand().toString(16)}：种群密度与分布格局的测定方法${rand() % 13}。`,
    ).join('');
    const bigXml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>` +
      `<w:p><w:r><w:t>第一章 机器学习基础</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>${pad}</w:t></w:r></w:p>` +
      `</w:body></w:document>`;
    const docxPath = join(dir, '讲义.docx');
    writeFileSync(docxPath, buildMiniZip([
      { name: 'word/document.xml', data: Buffer.from(bigXml, 'utf8') },
    ]));
    const { size } = await import('node:fs').then((fs) => fs.statSync(docxPath));
    expect(size).toBeGreaterThan(44 * 1024);

    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: docxPath },
    });
    expect(r.level).toBe('full');
    const data = r.data as { paragraphs: Array<{ text: string }> };
    expect(data.paragraphs.length).toBeGreaterThan(0);
    expect(data.paragraphs.some((p) => p.text.includes('种群密度'))).toBe(true);
  }, 30000);
});
