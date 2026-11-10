/**
 * 零依赖 XLSX 渲染（R10-1，core 层纯 TS，风格对齐 ooxmlRender/pdfRender）。
 *
 * XLSX = zip（PK）内 minimal OOXML 部件：
 *  [Content_Types].xml / _rels/.rels / xl/workbook.xml / xl/_rels/workbook.xml.rels /
 *  xl/styles.xml（最简）/ xl/worksheets/sheetN.xml（inlineStr 单元格，不建 sharedStrings）。
 * 多 sheet 支持；确定性字节（固定时间戳，同输入同字节）。
 *
 * 用途形态：导出产教分析包最实用——matched 关联表 / gaps 缺口表 / coverage 冗余表
 * 三 sheet；亦支持通用 { name?, header, rows } 表格数组（export_course_package 的
 * tables 输入）。真实 zip 可由 render_preview 的 xlsx 分支读回（互操作验证）。
 */

export interface XlsxTableInput {
  /** sheet 名（缺省 SheetN） */
  name?: string;
  header: string[];
  rows: string[][];
}

export interface XlsxBuildResult {
  bytes: Uint8Array;
  sheetCount: number;
  /** 每个 sheet 的数据行数（不含表头） */
  rowCounts: number[];
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(i: number): string {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** sheetN.xml：inlineStr 单元格（t="inlineStr"><is><t>），行号从 1 起；dimension 供 render_preview 读回行/列数 */
function sheetXml(table: XlsxTableInput): string {
  const rows: string[] = [];
  const all = [table.header, ...table.rows];
  const maxCols = Math.max(table.header.length, ...table.rows.map((r) => r.length), 1);
  const dimension = `<dimension ref="A1:${colName(maxCols - 1)}${all.length}"/>`;
  all.forEach((cells, r) => {
    const rs: string[] = [];
    cells.forEach((cell, c) => {
      const ref = `${colName(c)}${r + 1}`;
      rs.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(cell ?? ''))}</t></is></c>`);
    });
    rows.push(`<row r="${r + 1}">${rs.join('')}</row>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimension}<sheetData>${rows.join('')}</sheetData></worksheet>`;
}

/** 组装最小 xlsx zip（stored 段手写，与 packageWriter 同结构，确定性时间戳） */
export function buildXlsx(tables: XlsxTableInput[]): XlsxBuildResult {
  const sheets = tables.length > 0 ? tables : [{ name: 'Sheet1', header: [], rows: [] }];
  const files: Array<{ path: string; content: string }> = [];

  const sheetOverrides = sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  files.push({
    path: '[Content_Types].xml',
    content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheetOverrides}
</Types>`,
  });
  files.push({
    path: '_rels/.rels',
    content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  });
  const sheetEls = sheets
    .map((t, i) => `<sheet name="${escapeXml((t.name ?? `Sheet${i + 1}`).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  files.push({
    path: 'xl/workbook.xml',
    content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEls}</sheets></workbook>`,
  });
  const rels = sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');
  files.push({
    path: 'xl/_rels/workbook.xml.rels',
    content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  });
  files.push({
    path: 'xl/styles.xml',
    content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>`,
  });
  sheets.forEach((t, i) => {
    files.push({ path: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(t) });
  });

  // zip 组装（stored，固定 1980 时间戳，同 packageWriter.toZipBuffer 语义）
  const enc = (s: string) => Buffer.from(s, 'utf8');
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = enc(f.path);
    const dataBuf = enc(f.content);
    const crc = crc32(dataBuf);
    locals.push(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crc),
      u32(dataBuf.length), u32(dataBuf.length), u16(nameBuf.length), u16(0), nameBuf, dataBuf,
    );
    centrals.push(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crc),
      u32(dataBuf.length), u32(dataBuf.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBuf,
    );
    offset += 30 + nameBuf.length + dataBuf.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  return {
    bytes: new Uint8Array(Buffer.concat([...locals, centralBuf, eocd])),
    sheetCount: sheets.length,
    rowCounts: sheets.map((t) => t.rows.length),
  };
}

/** 产教分析包便捷形态：#29 link_knowledge_industry 输出 → 三表（matched/gaps/coverage） */
export function linkReportToTables(report: {
  matched?: Array<Record<string, unknown>>;
  gaps?: Array<Record<string, unknown>>;
  coverage?: Array<Record<string, unknown>>;
}): XlsxTableInput[] {
  const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
  const matched = report.matched ?? [];
  const gaps = report.gaps ?? [];
  const coverage = report.coverage ?? [];
  return [
    {
      name: 'matched 关联表',
      header: ['from（课程实体）', 'to（产业实体）', 'type', 'confidence', 'evidence', 'source'],
      rows: matched.map((m) => [s(m.from), s(m.to), s(m.type), s(m.confidence), s(m.evidence), s(m.source)]),
    },
    {
      name: 'gaps 缺口表',
      header: ['label', 'type', 'heat（岗位数）', 'demandedByOccupations', 'suggestion'],
      rows: gaps.map((g) => [s(g.label), s(g.type), s(g.heat), s(g.demandedByOccupations), s(g.suggestion)]),
    },
    {
      name: 'coverage 冗余表',
      header: ['label', 'note'],
      rows: coverage.map((c) => [s(c.label), s(c.note)]),
    },
  ];
}
