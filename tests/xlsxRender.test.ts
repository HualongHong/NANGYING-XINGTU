import { describe, expect, it } from 'vitest';
import { buildXlsx, linkReportToTables, type XlsxTableInput } from '../core/course/xlsxRender.js';
import { renderPreviewBytes } from '../adapters/core/renderPreview.js';

const TABLES: XlsxTableInput[] = [
  { name: 'matched 关联表', header: ['from', 'to', 'type'], rows: [['con-1', 'ind-1', 'maps_to_skill'], ['con-2', 'ind-2', 'supports_task']] },
  { name: 'gaps 缺口表', header: ['label', 'heat'], rows: [['GLP 规范', '2']] },
];

/** 列出 zip central directory 里的文件名（按 EOCD 计数校验条目数） */
function zipEntryCount(bytes: Uint8Array): number {
  // EOCD：尾 22 字节，offset 10 处 u16 = 条目总数
  const b = Buffer.from(bytes);
  return b.readUInt16LE(b.length - 22 + 10);
}

describe('R10-1 xlsxRender：零依赖 xlsx 写出', () => {
  it('结构：PK zip + 必备 OOXML 部件 + inlineStr 单元格 + dimension', () => {
    const { bytes, sheetCount, rowCounts } = buildXlsx(TABLES);
    const b = Buffer.from(bytes);
    expect(b.readUInt32LE(0)).toBe(0x04034b50); // PK\003\004
    expect(sheetCount).toBe(2);
    expect(rowCounts).toEqual([2, 1]);
    // 5 个固定部件（[Content_Types]/.rels/workbook/workbook.rels/styles）+ 2 个 sheet
    expect(zipEntryCount(bytes)).toBe(7);
    const text = b.toString('utf8');
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
      expect(text).toContain(part);
    }
    // inlineStr 单元格（不建 sharedStrings）
    expect(text).toContain('t="inlineStr"');
    expect(text).not.toContain('sharedStrings');
    // dimension 供 render_preview 读回行列数（sheet1：3 列 3 行 = header+2）
    expect(text).toMatch(/<dimension ref="A1:C3"\/>/);
  });

  it('确定性：同输入同字节（固定时间戳），两次构建逐字节一致', () => {
    const a = buildXlsx(TABLES);
    const b2 = buildXlsx(TABLES);
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b2.bytes))).toBe(0);
    // 表格内容影响字节
    const c = buildXlsx([{ header: ['x'], rows: [['y']] }]);
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(c.bytes))).not.toBe(0);
  });

  it('互操作：真实 zip 可被 render_preview 的 xlsx 分支读回（sheet 名/行/列）', () => {
    const { bytes } = buildXlsx(TABLES);
    const report = renderPreviewBytes(bytes, { claimed: { type: 'xlsx', claimed: 'xlsx' } });
    expect(report.fileType).toBe('xlsx');
    expect(report.xlsx).toBeDefined();
    expect(report.xlsx!.sheets.map((s) => s.name)).toEqual(['matched 关联表', 'gaps 缺口表']);
    expect(report.xlsx!.sheets[0]).toMatchObject({ rows: 3, cols: 3 });
    expect(report.xlsx!.sheets[1]).toMatchObject({ rows: 2, cols: 2 });
  });

  it('XML 转义：& < > " 与空格保留', () => {
    const { bytes } = buildXlsx([{ header: ['a'], rows: [['<b> & "引号"  x']] }]);
    const xml = Buffer.from(bytes).toString('utf8');
    expect(xml).toContain('&lt;b&gt; &amp; &quot;引号&quot;');
    expect(xml).not.toContain('<b>');
  });

  it('空表格数组回退单空 sheet；linkReportToTables 三表表头', () => {
    const empty = buildXlsx([]);
    expect(empty.sheetCount).toBe(1);
    expect(zipEntryCount(empty.bytes)).toBe(6);
    const tables = linkReportToTables({
      matched: [{ from: 'con-1', to: 'ind-1', type: 'maps_to_skill', confidence: 1, evidence: '术语精确匹配', source: 'lexical' }],
      gaps: [{ industryEntityId: 'ind-9', label: 'GLP 规范', type: 'skill', heat: 2, demandedByOccupations: ['质量控制专员'], suggestion: '建议补充教学点：GLP 规范' }],
      coverage: [{ entityId: 'con-3', label: '种群密度', note: '零产业关联' }],
    });
    expect(tables.map((t) => t.name)).toEqual(['matched 关联表', 'gaps 缺口表', 'coverage 冗余表']);
    expect(tables[0].header).toEqual(['from（课程实体）', 'to（产业实体）', 'type', 'confidence', 'evidence', 'source']);
    expect(tables[0].rows[0]).toEqual(['con-1', 'ind-1', 'maps_to_skill', '1', '术语精确匹配', 'lexical']);
    expect(tables[1].header[0]).toBe('label');
    expect(tables[1].rows[0]).toEqual(['GLP 规范', 'skill', '2', '质量控制专员', '建议补充教学点：GLP 规范']);
    expect(tables[2].rows[0]).toEqual(['种群密度', '零产业关联']);
    // 端到端：linkReport → 三表 → xlsx → render_preview 读回
    const { bytes } = buildXlsx(tables);
    const report = renderPreviewBytes(bytes, { claimed: { type: 'xlsx', claimed: 'xlsx' } });
    expect(report.xlsx!.sheets.map((s) => s.rows)).toEqual([2, 2, 2]);
  });
});
