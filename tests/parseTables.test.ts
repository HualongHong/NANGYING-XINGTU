import { describe, expect, it } from 'vitest';
import { parseCourseMaterial, extractTableBlocks } from '../core/nlp/parseCourseMaterial.js';
import { buildMiniZip } from './helpers/miniPptx.js';

const MD_WITH_TABLE = [
  '# 教学日历',
  '',
  '本学期共十六周，进度安排如下。',
  '',
  '| 周次 | 教学内容 | 学时 |',
  '| --- | --- | --- |',
  '| 1 | 种群生态学导论 | 2 |',
  '| 2 | 标志重捕法实验 | 4 |',
  '| 3 | 生态系统能量流动 | 2 |',
  '',
  '## 第二章 实验安全',
  '',
  '实验安全守则另发。',
].join('\n');

describe('R3-3 表格保真（反馈 b P1-1：整张表不再压成一个 paragraph）', () => {
  it('Markdown 管道表格 → tables[]（表头/数据行/章节归属），表格行不进 paragraphs', async () => {
    const r = await parseCourseMaterial({ content: MD_WITH_TABLE, materialType: 'md' });
    expect(r.level).toBe('full');
    const data = r.data!;
    expect(data.tables).toHaveLength(1);
    const t = data.tables[0];
    expect(t.header).toEqual(['周次', '教学内容', '学时']);
    expect(t.rows).toEqual([
      ['1', '种群生态学导论', '2'],
      ['2', '标志重捕法实验', '4'],
      ['3', '生态系统能量流动', '2'],
    ]);
    expect(t.sectionOrder).toBe(0); // 归属「教学日历」章节
    // 整张表不再是一个 paragraph
    expect(data.paragraphs.some((p) => p.text.includes('周次 | 教学内容'))).toBe(false);
    expect(data.paragraphs.some((p) => p.text.includes('种群生态学导论'))).toBe(false);
    // 章节结构不受影响
    expect(data.structuredSections[0].title).toBe('教学日历');
  });

  it('表格单元格文本并入知识点候选（去重、低权）', async () => {
    const r = await parseCourseMaterial({ content: MD_WITH_TABLE, materialType: 'md' });
    const terms = r.data!.knowledgePointCandidates.map((c) => c.term);
    expect(terms).toContain('标志重捕法实验'); // 来自表格单元格
    // 不重复：唯一一次
    expect(terms.filter((t) => t === '标志重捕法实验')).toHaveLength(1);
  });

  it('docx 表格行（" | " 形态）同样结构化（章节归属 -1：无标题文本）', async () => {
    const documentXml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>` +
      `<w:p><w:r><w:t>讲义正文段落。</w:t></w:r></w:p>` +
      `<w:tbl>` +
      `<w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>含义</w:t></w:r></w:p></w:tc></w:tr>` +
      `<w:tr><w:tc><w:p><w:r><w:t>种群密度</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>单位面积个体数</w:t></w:r></w:p></w:tc></w:tr>` +
      `</w:tbl>` +
      `</w:body></w:document>`;
    const docx = new Uint8Array(buildMiniZip([
      { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    ]));
    // 经适配层 docxTextExtract 的文本形态（" | " 行）直接走 parse 文本管线验证
    const { extractDocxText } = await import('../adapters/core/decoders/docxTextExtract.js');
    const r = await parseCourseMaterial({ content: extractDocxText(docx), materialType: 'docx' });
    expect(r.data!.tables).toHaveLength(1);
    expect(r.data!.tables[0].header).toEqual(['指标', '含义']);
    expect(r.data!.tables[0].rows).toEqual([['种群密度', '单位面积个体数']]);
    expect(r.data!.tables[0].sectionOrder).toBe(-1);
  });

  it('extractTableBlocks：单行管道行不误判为表格；分隔行正确剔除', () => {
    const lines = ['文中提到 a | b 的对比', '| 表头一 | 表头二 |', '| --- | --- |', '| 甲 | 乙 |'];
    const blocks = extractTableBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].rows).toEqual([['表头一', '表头二'], ['甲', '乙']]);
    expect(blocks[0].start).toBe(1); // 首行散文不被吞
  });
});
