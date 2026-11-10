/**
 * 零依赖 PDF 渲染（R7-3，core 层纯 TS，参考 ooxmlRender 风格）。
 *
 * 反馈 a N1：中文试卷/讲义 PDF 直出。CJK 现实约束的诚实方案：
 *  - 传入中文字体字节（font.bytes，.ttf/.ttc 由适配层读取）：解析 TTF cmap
 *    （format 4/12，TTC 取首个字体）建立 Unicode→glyphId 映射，嵌入整字体
 *    （CIDFontType2，非子集化），/Identity-H 编码 + 生成 ToUnicode CMap；
 *  - 未传字体：Helvetica 仅覆盖拉丁/数字，非可编码字符替换为 '?' 并计数
 *    （调用方据 replacedChars 决定是否降级说明，绝不假装中文渲染成功）。
 *
 * 排版：标题/段落/表格线框/分页（A4，固定边距）；确定性字节（固定时间戳、
 * 同输入同字节）。文本算子用 2 字节大端 glyphId（嵌入字体）或 cp1252（Helvetica）。
 */

// ---------- TTF/TTC 解析（cmap format 4/12 + hmtx 宽度） ----------

export interface EmbeddedFont {
  bytes: Uint8Array;
  /** Unicode 码点 → glyphId */
  cmap: Map<number, number>;
  /** glyphId → 字宽（原始单位） */
  widths: Map<number, number>;
  unitsPerEm: number;
  postScriptName: string;
  /** 内部：子集化用的原始表结构（parseTrueTypeFont 填充） */
  internals?: {
    base: number;
    tables: Map<string, { off: number; len: number }>;
    numGlyphs: number;
  };
}

function u16(b: Uint8Array, o: number): number { return (b[o] << 8) | b[o + 1]; }
function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** 解析 TTF/TTC 字体：cmap（format 4/12）+ hmtx 字宽 */
export function parseTrueTypeFont(bytes: Uint8Array): EmbeddedFont | null {
  let base = 0;
  let b = bytes;
  // TTC 集合：取首个字体
  if (b.length > 12 && b[0] === 0x74 && b[1] === 0x74 && b[2] === 0x63 && b[3] === 0x66) {
    base = u32(b, 12);
    if (base + 12 > b.length) return null;
  }
  const numTables = u16(b, base + 4);
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > b.length) return null;
    const tag = String.fromCharCode(b[rec], b[rec + 1], b[rec + 2], b[rec + 3]);
    tables.set(tag, { off: u32(b, rec + 8), len: u32(b, rec + 12) });
  }
  const head = tables.get('head');
  const cmapT = tables.get('cmap');
  const hhea = tables.get('hhea');
  const hmtxT = tables.get('hmtx');
  const nameT = tables.get('name');
  if (!head || !cmapT || !hhea || !hmtxT) return null;

  const unitsPerEm = u16(b, head.off + 18);

  // cmap：优先 format 12（平台 3/10 或 0），其次 format 4
  const cmap = new Map<number, number>();
  const numRec = u16(b, cmapT.off + 2);
  let fmt12: { off: number } | null = null;
  let fmt4: { off: number } | null = null;
  for (let i = 0; i < numRec; i++) {
    const rec = cmapT.off + 4 + i * 8;
    const platform = u16(b, rec);
    const enc = u16(b, rec + 2);
    const subOff = cmapT.off + u32(b, rec + 4);
    const fmt = u16(b, subOff);
    if (fmt === 12 && (platform === 3 || platform === 0) && !fmt12) fmt12 = { off: subOff };
    if (fmt === 4 && (platform === 3 || platform === 0) && !fmt4) fmt4 = { off: subOff };
  }
  if (fmt12) {
    const o = fmt12.off;
    const nGroups = u32(b, o + 12);
    for (let g = 0; g < nGroups && o + 16 + g * 12 + 12 <= b.length; g++) {
      const go = o + 16 + g * 12;
      const start = u32(b, go);
      const end = u32(b, go + 4);
      const startGid = u32(b, go + 8);
      for (let c = start; c <= end && c - start < 0x100000; c++) cmap.set(c, startGid + (c - start));
    }
  } else if (fmt4) {
    const o = fmt4.off;
    const segCount = u16(b, o + 6) / 2;
    const endBase = o + 14;
    const startBase = endBase + 2 * segCount + 2;
    const deltaBase = startBase + 2 * segCount;
    const rangeBase = deltaBase + 2 * segCount;
    for (let s = 0; s < segCount; s++) {
      const endC = u16(b, endBase + 2 * s);
      const startC = u16(b, startBase + 2 * s);
      const delta = u16(b, deltaBase + 2 * s);
      const rangeOff = u16(b, rangeBase + 2 * s);
      for (let c = startC; c <= endC && c < 0x10000; c++) {
        let gid: number;
        if (rangeOff === 0) gid = (c + delta) & 0xffff;
        else {
          const addr = rangeBase + 2 * s + rangeOff + 2 * (c - startC);
          gid = addr + 2 <= b.length ? u16(b, addr) : 0;
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid !== 0) cmap.set(c, gid);
      }
    }
  }
  if (cmap.size === 0) return null;

  // hmtx 字宽
  const widths = new Map<number, number>();
  const numHMetrics = u16(b, hhea.off + 34);
  const numGlyphs = (() => {
    const maxp = tables.get('maxp');
    return maxp ? u16(b, maxp.off + 4) : numHMetrics;
  })();
  for (let g = 0; g < numGlyphs; g++) {
    const adv = g < numHMetrics
      ? u16(b, hmtxT.off + 4 * g)
      : u16(b, hmtxT.off + 4 * (numHMetrics - 1));
    widths.set(g, adv);
  }

  // PostScript 名（name ID 6）
  let psName = 'EmbeddedFont';
  if (nameT) {
    const count = u16(b, nameT.off + 2);
    for (let i = 0; i < count; i++) {
      const rec = nameT.off + 6 + i * 12;
      if (u16(b, rec + 6) !== 6) continue;
      const platform = u16(b, rec);
      const len = u16(b, rec + 8);
      const off = nameT.off + u16(b, rec + 10);
      if (off + len > b.length) continue;
      let s = '';
      for (let k = 0; k < len; k += 2) {
        const code = platform === 0 || platform === 3 ? u16(b, off + k) : b[off + k];
        if (code === 0) break;
        s += String.fromCharCode(code);
      }
      if (s) { psName = s.replace(/[^\x21-\x7E]/g, ''); break; }
    }
  }

  return {
    bytes,
    cmap,
    widths,
    unitsPerEm,
    postScriptName: psName || 'EmbeddedFont',
    internals: { base, tables, numGlyphs },
  };
}

// ---------- TTF 子集化（R8-3：嵌入前按用到的字符集瘦身） ----------

/**
 * 实用折中：仅当用到的字符数 < 字体 cmap 的 30% 时子集化，否则返回 null（整字体嵌入）。
 * 处理 glyf 复合字形（component 传递闭包）、重建 cmap(format 4)/loca(长格式)/hmtx/maxp/head，
 * 其余表原样拷贝；PDF 文本可复制性由 buildPdf 的 ToUnicode 生成保证。
 * 确定性字节；任何解析失败返回 null（回退整字体，绝不产出坏字体）。
 */
export function subsetTrueTypeFont(
  font: EmbeddedFont,
  usedCodepoints: Set<number>,
): EmbeddedFont | null {
  const internals = font.internals;
  if (!internals || usedCodepoints.size === 0) return null;
  if (usedCodepoints.size >= font.cmap.size * 0.3) return null;
  const cps = [...usedCodepoints]
    .filter((c) => c <= 0xffff && font.cmap.has(c))
    .sort((a, b) => a - b);
  if (cps.length === 0 || cps.length >= font.cmap.size * 0.3) return null;

  const b = font.bytes;
  const { tables, numGlyphs: origGlyphs } = internals;
  const headT = tables.get('head');
  const hheaT = tables.get('hhea');
  const maxpT = tables.get('maxp');
  const hmtxT = tables.get('hmtx');
  const locaT = tables.get('loca');
  const glyfT = tables.get('glyf');
  if (!headT || !hheaT || !maxpT || !hmtxT || !locaT || !glyfT) return null;

  const locaFmt = u16(b, headT.off + 50);
  const numHMetrics = u16(b, hheaT.off + 34);
  const offsetOf = (gid: number): number =>
    locaFmt === 0 ? u16(b, locaT.off + gid * 2) * 2 : u32(b, locaT.off + gid * 4);
  const glyfEntry = (gid: number): Uint8Array =>
    b.subarray(glyfT.off + offsetOf(gid), glyfT.off + offsetOf(gid + 1));

  // 复合字形 component 解析（flags/glyphIndex 走查）
  const componentGids = (entry: Uint8Array): number[] => {
    if (u16(entry, 0) >= 0) return [];
    const out: number[] = [];
    let p = 10;
    for (let guard = 0; guard < 64; guard++) {
      if (p + 4 > entry.length) break;
      const flags = u16(entry, p);
      out.push(u16(entry, p + 2));
      p += 4;
      p += flags & 0x0001 ? 4 : 2;
      if (flags & 0x0008) p += 2;
      else if (flags & 0x0040) p += 4;
      else if (flags & 0x0080) p += 8;
      if (!(flags & 0x0020)) break; // MORE_COMPONENTS
    }
    return out;
  };

  // 用到的 glyph 集合 + 复合依赖传递闭包
  const gidSet = new Set<number>(cps.map((c) => font.cmap.get(c)!));
  const queue = [...gidSet];
  while (queue.length > 0) {
    const g = queue.pop()!;
    if (g >= origGlyphs) continue;
    for (const dep of componentGids(glyfEntry(g))) {
      if (dep < origGlyphs && !gidSet.has(dep)) {
        gidSet.add(dep);
        queue.push(dep);
      }
    }
  }
  const sortedGids = [...gidSet].sort((x, y) => x - y);
  const newGidOf = new Map(sortedGids.map((g, i) => [g, i]));

  // 原 hmtx 度量提取
  const metricOf = (gid: number): [number, number] => {
    if (gid < numHMetrics) return [u16(b, hmtxT.off + 4 * gid), u16(b, hmtxT.off + 4 * gid + 2)];
    return [
      u16(b, hmtxT.off + 4 * (numHMetrics - 1)),
      u16(b, hmtxT.off + 4 * numHMetrics + 2 * (gid - numHMetrics)),
    ];
  };

  // 新 glyf + loca（长格式）
  const glyfParts: Buffer[] = [];
  const locaOffsets: number[] = [0];
  for (const g of sortedGids) {
    const entry = Buffer.from(glyfEntry(g));
    glyfParts.push(entry);
    locaOffsets.push(locaOffsets[locaOffsets.length - 1] + entry.length);
  }
  const newGlyf = Buffer.concat(glyfParts);
  const newLoca = Buffer.alloc(locaOffsets.length * 4);
  locaOffsets.forEach((off, i) => newLoca.writeUInt32BE(off, i * 4));

  // 新 hmtx（全 long metrics）
  const newNumGlyphs = sortedGids.length;
  const newHmtx = Buffer.alloc(newNumGlyphs * 4);
  const newWidths = new Map<number, number>();
  sortedGids.forEach((g, i) => {
    const [adv, lsb] = metricOf(g);
    newHmtx.writeUInt16BE(adv, i * 4);
    newHmtx.writeInt16BE(lsb > 32767 ? lsb - 65536 : lsb, i * 4 + 2);
    newWidths.set(i, adv);
  });

  // 新 cmap（format 4，连续码点段用 idDelta）
  const runs: Array<[number, number, number]> = []; // [start, end, firstNewGid]
  let i = 0;
  while (i < cps.length) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j++;
    runs.push([cps[i], cps[j], newGidOf.get(font.cmap.get(cps[i])!)!]);
    i = j + 1;
  }
  const segCount = runs.length + 1;
  const pow2 = 2 ** Math.floor(Math.log2(segCount));
  const f4 = Buffer.alloc(16 + segCount * 8);
  f4.writeUInt16BE(4, 0);
  f4.writeUInt16BE(f4.length, 2);
  f4.writeUInt16BE(0, 4);
  f4.writeUInt16BE(segCount * 2, 6);
  f4.writeUInt16BE(pow2 * 2, 8);
  f4.writeUInt16BE(Math.log2(pow2), 10);
  f4.writeUInt16BE(segCount * 2 - pow2 * 2, 12);
  runs.forEach(([s, e], k) => f4.writeUInt16BE(e, 14 + 2 * k));
  f4.writeUInt16BE(0xffff, 14 + 2 * runs.length);
  const startBase = 14 + 2 * segCount + 2;
  runs.forEach(([s], k) => f4.writeUInt16BE(s, startBase + 2 * k));
  f4.writeUInt16BE(0xffff, startBase + 2 * runs.length);
  const deltaBase = startBase + 2 * segCount;
  runs.forEach(([s, , firstGid], k) => f4.writeUInt16BE((firstGid - s) & 0xffff, deltaBase + 2 * k));
  f4.writeUInt16BE(1, deltaBase + 2 * runs.length);
  const newCmap = Buffer.alloc(4 + 8 + f4.length);
  newCmap.writeUInt16BE(0, 0);
  newCmap.writeUInt16BE(1, 2);
  newCmap.writeUInt16BE(3, 4);
  newCmap.writeUInt16BE(1, 6);
  newCmap.writeUInt32BE(12, 8);
  f4.copy(newCmap, 12);

  // head/hhea/maxp 拷贝 + 补丁
  const newHead = Buffer.from(b.subarray(headT.off, headT.off + 54));
  newHead.writeUInt32BE(0, 8); // checkSumAdjustment 先清零
  newHead.writeInt16BE(1, 50); // 长 loca
  const newHhea = Buffer.from(b.subarray(hheaT.off, hheaT.off + 36));
  newHhea.writeUInt16BE(newNumGlyphs, 34);
  const newMaxp = Buffer.from(b.subarray(maxpT.off, maxpT.off + maxpT.len));
  newMaxp.writeUInt16BE(newNumGlyphs, 4);

  // 组装 sfnt：改写的表 + 其余原样
  const rebuilt = new Map<string, Buffer>([
    ['glyf', newGlyf], ['loca', newLoca], ['cmap', newCmap],
    ['hmtx', newHmtx], ['head', newHead], ['hhea', newHhea], ['maxp', newMaxp],
  ]);
  const tags = [...tables.keys()].sort(); // 目录按 tag 字典序
  const numTables = tags.length;
  const header = Buffer.alloc(12);
  header.writeUInt32BE(u32(b, internals.base), 0);
  header.writeUInt16BE(numTables, 4);
  const pow2t = 2 ** Math.floor(Math.log2(numTables));
  header.writeUInt16BE(pow2t * 16, 6);
  header.writeUInt16BE(Math.log2(pow2t), 8);
  header.writeUInt16BE(numTables * 16 - pow2t * 16, 10);
  const dirLen = 12 + numTables * 16;
  let dataOff = dirLen;
  const recs: Buffer[] = [];
  const datas: Buffer[] = [];
  for (const tag of tags) {
    const data = rebuilt.get(tag) ?? Buffer.from(b.subarray(tables.get(tag)!.off, tables.get(tag)!.off + tables.get(tag)!.len));
    const padded = data.length % 4 === 0 ? data : Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
    const rec = Buffer.alloc(16);
    rec.write(tag, 0, 'latin1');
    let sum = 0;
    for (let k = 0; k + 4 <= padded.length; k += 4) sum = (sum + padded.readUInt32BE(k)) >>> 0;
    rec.writeUInt32BE(sum >>> 0, 4);
    rec.writeUInt32BE(dataOff, 8);
    rec.writeUInt32BE(data.length, 12);
    recs.push(rec);
    datas.push(padded);
    dataOff += padded.length;
  }
  const fontOut = Buffer.concat([header, ...recs, ...datas]);
  // checkSumAdjustment：整体校验和（head 区按 0 计）→ 0xB1B0AFBA - sum，写入 head 表数据区
  let total = 0;
  for (let k = 0; k + 4 <= fontOut.length; k += 4) total = (total + fontOut.readUInt32BE(k)) >>> 0;
  const adjust = (0xb1b0afba - total) >>> 0;
  {
    let off = dirLen;
    for (const tag of tags) {
      const data = rebuilt.get(tag) ?? Buffer.from(b.subarray(tables.get(tag)!.off, tables.get(tag)!.off + tables.get(tag)!.len));
      const padded = data.length % 4 === 0 ? data.length : data.length + 4 - (data.length % 4);
      if (tag === 'head') {
        fontOut.writeUInt32BE(adjust, off + 8);
        break;
      }
      off += padded;
    }
  }

  const newCmapMap = new Map<number, number>(cps.map((c) => [c, newGidOf.get(font.cmap.get(c)!)!]));
  return {
    bytes: new Uint8Array(fontOut),
    cmap: newCmapMap,
    widths: newWidths,
    unitsPerEm: font.unitsPerEm,
    postScriptName: font.postScriptName,
    internals: { base: 0, tables: new Map(), numGlyphs: newNumGlyphs },
  };
}

/** 收集文本用到的全部码点（子集化字符集） */
function collectCodepoints(input: PdfBuildInput): Set<number> {
  const out = new Set<number>();
  const add = (s: string) => { for (const ch of s) out.add(ch.codePointAt(0) ?? 0); };
  add(input.title);
  for (const block of input.blocks) {
    if (block.text) add(block.text);
    for (const row of block.rows ?? []) {
      for (const cell of row) add(typeof cell === 'string' ? cell : cell.text);
    }
  }
  return out;
}

// ---------- 布局与构建 ----------

export interface PdfBlock {
  kind: 'h1' | 'h2' | 'p' | 'table';
  text?: string;
  rows?: Array<Array<string | PdfCell>>;
}

/**
 * R13：表格格子（向后兼容：纯字符串格子等价为 { text }）。
 * colSpan/rowSpan ≥2 时该区域合并，线框不穿越合并区；align 缺省 left。
 */
export interface PdfCell {
  text: string;
  colSpan?: number;
  rowSpan?: number;
  align?: 'left' | 'center';
}

export interface PdfBuildInput {
  title: string;
  blocks: PdfBlock[];
  /** 嵌入中文字体（parseTrueTypeFont 的产出）；null = Helvetica 拉丁模式 */
  font?: EmbeddedFont | null;
}

export interface PdfBuildResult {
  bytes: Uint8Array;
  embeddedFont: boolean;
  /** Helvetica 模式下被 '?' 替换的非可编码字符数 */
  replacedChars: number;
  pageCount: number;
}

const PAGE_W = 595.28; // A4 pt
const PAGE_H = 841.89;
const MARGIN = 56;

/** 文本折行：返回行数组（嵌入字体按字宽，拉丁按 0.5em） */
function wrapText(text: string, maxWidth: number, size: number, font: EmbeddedFont | null): string[] {
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  const charWidth = (ch: string): number => {
    if (!font) return ch.charCodeAt(0) > 0xff ? size : size * 0.5;
    const gid = font.cmap.get(ch.codePointAt(0) ?? 0);
    if (gid === undefined) return size;
    const w = font.widths.get(gid) ?? font.unitsPerEm;
    return (w / font.unitsPerEm) * size;
  };
  for (const ch of text) {
    if (ch === '\n') { lines.push(cur); cur = ''; curW = 0; continue; }
    const w = charWidth(ch);
    if (curW + w > maxWidth && cur !== '') { lines.push(cur); cur = ch; curW = w; continue; }
    cur += ch;
    curW += w;
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [''];
}

/** 文本 → 内容流 hex 串（嵌入字体：glyphId 2 字节；否则 cp1252） */
function encodeText(text: string, font: EmbeddedFont | null, replaced: { n: number }): string {
  const out: number[] = [];
  for (const ch of text) {
    if (font) {
      const gid = font.cmap.get(ch.codePointAt(0) ?? 0);
      if (gid === undefined) { out.push(0, 0x3f); continue; }
      out.push((gid >> 8) & 0xff, gid & 0xff);
    } else {
      const code = ch.charCodeAt(0);
      if (code <= 0xff) out.push(code);
      else { out.push(0x3f); replaced.n += 1; }
    }
  }
  return out.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ---------- PDF 对象组装 ----------

class PdfWriter {
  private parts: Buffer[] = [];
  private offsets: number[] = [];
  objectCount = 0;

  beginObject(): number {
    this.objectCount += 1;
    this.offsets.push(Buffer.concat(this.parts).length);
    return this.objectCount;
  }

  write(s: string | Buffer): void {
    this.parts.push(typeof s === 'string' ? Buffer.from(s, 'latin1') : s);
  }

  finish(rootObj: number, infoObj: number): Uint8Array {
    const xrefPos = Buffer.concat(this.parts).length;
    let xref = `xref\n0 ${this.objectCount + 1}\n0000000000 65535 f \n`;
    for (const off of this.offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    this.parts.push(Buffer.from(xref, 'latin1'));
    this.parts.push(Buffer.from(
      `trailer\n<< /Size ${this.objectCount + 1} /Root ${rootObj} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`,
      'latin1',
    ));
    return new Uint8Array(Buffer.concat(this.parts));
  }
}

export function buildPdf(input: PdfBuildInput): PdfBuildResult {
  // R8-3：嵌入前按用到的字符集子集化（<30% 才做；失败回退整字体，绝不产出坏字体）
  let font = input.font ?? null;
  if (font) {
    font = subsetTrueTypeFont(font, collectCodepoints(input)) ?? font;
  }
  const replaced = { n: 0 };

  // 布局：块 → 行（含样式）
  interface Line { text: string; size: number; bold: boolean; indent: number; y: number }
  interface TableCell {
    text: string; colSpan: number; rowSpan: number; align: 'left' | 'center'; r: number; c: number;
  }
  interface TableRegion {
    x: number; y: number;
    /** 无 span 表的旧渲染路径数据（逐字节兼容） */
    plainRows: string[][] | null;
    cells: TableCell[];
    /** anchorOf[r][c] = 覆盖该格的 anchor 下标（span 渲染用） */
    anchorOf: number[][];
    cols: number; colW: number; rowH: number; rows: number;
    hasSpan: boolean;
  }
  const usedGids = new Set<number>();
  const lines: Line[] = [];
  const tables: TableRegion[] = [];
  let y = PAGE_H - MARGIN;

  const addLine = (text: string, size: number, bold: boolean, indent: number) => {
    y -= size * 1.55;
    lines.push({ text, size, bold, indent, y });
    if (font) for (const ch of text) {
      const gid = font.cmap.get(ch.codePointAt(0) ?? 0);
      if (gid !== undefined) usedGids.add(gid);
    }
  };

  addLine(input.title, 20, true, 0);
  for (const block of input.blocks) {
    if (block.kind === 'table' && block.rows && block.rows.length > 0) {
      // R13：格子归一化 + span 网格（anchorOf）；无 span 走旧路径逐字节兼容
      const norm = (cell: string | PdfCell): PdfCell =>
        typeof cell === 'string' ? { text: cell } : cell;
      const raw = block.rows.map((r) => r.map(norm));
      const cells: TableCell[] = [];
      const anchorOf: number[][] = [];
      let cols = 0;
      raw.forEach((row, r) => {
        anchorOf[r] = anchorOf[r] ?? [];
        let c = 0;
        for (const cell of row) {
          while (anchorOf[r][c] !== undefined) c++; // 跳过被上方 rowSpan 覆盖的列
          const cs = Math.max(1, Math.floor(cell.colSpan ?? 1));
          const rs = Math.max(1, Math.floor(cell.rowSpan ?? 1));
          const idx = cells.length;
          cells.push({ text: cell.text, colSpan: cs, rowSpan: rs, align: cell.align ?? 'left', r, c });
          for (let dr = 0; dr < rs; dr++) {
            anchorOf[r + dr] = anchorOf[r + dr] ?? [];
            for (let dc = 0; dc < cs; dc++) anchorOf[r + dr][c + dc] = idx;
          }
          c += cs;
        }
        cols = Math.max(cols, c, anchorOf[r].length);
      });
      const hasSpan = cells.some((t) => t.colSpan > 1 || t.rowSpan > 1);
      const colW = (PAGE_W - 2 * MARGIN) / cols;
      const rowH = 20;
      // 行高推进：无 span 与旧公式逐字节一致（wrap 宽 colW-8，max 行数 ×14+8）
      const heights = raw.map((row) => {
        const lens = row.map((cell) =>
          wrapText(cell.text, (cell.colSpan ?? 1) * colW - 8, 10, font).length);
        return Math.max(...lens, 1) * 14 + 8;
      });
      const totalH = heights.reduce((a, b) => a + b, 0);
      y -= totalH + 10;
      tables.push({
        x: MARGIN, y: y + 6,
        plainRows: hasSpan ? null : raw.map((r) => r.map((t) => t.text)),
        cells, anchorOf, cols, colW, rowH, rows: raw.length, hasSpan,
      });
      continue;
    }
    const size = block.kind === 'h1' ? 16 : block.kind === 'h2' ? 13 : 10.5;
    const bold = block.kind !== 'p';
    for (const ln of wrapText(block.text ?? '', PAGE_W - 2 * MARGIN, size, font)) {
      addLine(ln, size, bold, block.kind === 'p' ? 12 : 0);
    }
    y -= size * 0.5;
  }

  // 分页（行按 y 所属页）
  const linesPerPage: Line[][] = [[]];
  const pageOfY = (yy: number) => Math.floor(((PAGE_H - MARGIN) - yy) / (PAGE_H - 2 * MARGIN));
  for (const ln of lines) {
    const p = pageOfY(ln.y);
    while (linesPerPage.length <= p) linesPerPage.push([]);
    linesPerPage[p].push(ln);
  }
  const pageCount = linesPerPage.length;
  const tablePages = tables.map((t) => pageOfY(t.y + t.rowH * t.rows));

  // 内容流
  const contentOf = (pageIdx: number): string => {
    let s = 'q\n';
    for (const ln of linesPerPage[pageIdx] ?? []) {
      const encoded = encodeText(ln.text, font, replaced);
      s += `BT /F1 ${ln.size} Tf 1 0 0 1 ${MARGIN + ln.indent} ${ln.y - pageIdx * (PAGE_H - 2 * MARGIN)} Tm <${encoded}> Tj ET\n`;
    }
    for (let t = 0; t < tables.length; t++) {
      if (tablePages[t] !== pageIdx) continue;
      const tb = tables[t];
      const top = tb.y + tb.rows * tb.rowH - pageIdx * (PAGE_H - 2 * MARGIN);
      if (!tb.hasSpan && tb.plainRows) {
        // 旧渲染路径（无 span 逐字节兼容）
        const rows = tb.plainRows;
        const colW = tb.colW;
        const cols = tb.cols;
        for (let r = 0; r <= rows.length; r++) {
          const ry = top - r * tb.rowH;
          s += `${tb.x} ${ry} m ${tb.x + colW * cols} ${ry} l S\n`;
        }
        for (let c = 0; c <= cols; c++) {
          const cx = tb.x + c * colW;
          s += `${cx} ${top - rows.length * tb.rowH} m ${cx} ${top} l S\n`;
        }
        for (let r = 0; r < rows.length; r++) {
          for (let c = 0; c < cols; c++) {
            const cell = rows[r][c] ?? '';
            if (!cell) continue;
            s += `BT /F1 10 Tf 1 0 0 1 ${tb.x + c * colW + 4} ${top - (r + 1) * tb.rowH + 6} Tm <${encodeText(cell, font, replaced)}> Tj ET\n`;
          }
        }
        continue;
      }
      // R13：span 渲染——线框按 anchor 分段，边界线不穿越合并区
      const { cols, colW, rowH, cells, anchorOf } = tb;
      const xOf = (c: number) => tb.x + c * colW;
      const yOf = (r: number) => top - r * rowH;
      const anchorAt = (r: number, c: number): number =>
        r >= 0 && r < tb.rows && c >= 0 && c < cols ? anchorOf[r][c] ?? -1 : -1;
      for (let r = 0; r <= tb.rows; r++) {
        for (let c = 0; c < cols; c++) {
          // 上下同 anchor（同格内部）→ 该列段无线
          if (anchorAt(r - 1, c) === anchorAt(r, c) && anchorAt(r - 1, c) >= 0) continue;
          s += `${xOf(c)} ${yOf(r)} m ${xOf(c + 1)} ${yOf(r)} l S\n`;
        }
      }
      for (let c = 0; c <= cols; c++) {
        for (let r = 0; r < tb.rows; r++) {
          // 左右同 anchor → 该行段无线
          if (anchorAt(r, c - 1) === anchorAt(r, c) && anchorAt(r, c) >= 0) continue;
          s += `${xOf(c)} ${yOf(r + 1)} m ${xOf(c)} ${yOf(r)} l S\n`;
        }
      }
      for (const cell of cells) {
        if (!cell.text) continue;
        const w = cell.colSpan * colW;
        const tx = cell.align === 'center' ? xOf(cell.c) + w / 2 : xOf(cell.c) + 4;
        const ty = yOf(cell.r) - (cell.rowSpan * rowH) / 2 + 3; // 合并区垂直居中
        s += `BT /F1 10 Tf 1 0 0 1 ${tx} ${ty} Tm <${encodeText(cell.text, font, replaced)}> Tj ET\n`;
      }
    }
    s += 'Q';
    return s;
  };

  // 组装对象
  const w = new PdfWriter();
  w.write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const fontFileObj = font ? w.beginObject() : 0;
  if (font) {
    const len = font.bytes.length;
    w.write(`${fontFileObj} 0 obj\n<< /Length ${len} /Length1 ${len} >>\nstream\n`);
    w.write(Buffer.from(font.bytes));
    w.write('\nendstream\nendobj\n');
  }
  const cidFontObj = font ? w.beginObject() : 0;
  if (font) {
    // /W：用到的 glyph 宽度（按 gid 排序分组）
    const sorted = [...usedGids].sort((a, b) => a - b);
    const wParts: string[] = [];
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
      const widthsArr = sorted.slice(i, j + 1).map((g) => {
        const adv = font.widths.get(g) ?? font.unitsPerEm;
        return Math.round((adv / font.unitsPerEm) * 1000);
      });
      wParts.push(`${sorted[i]} [ ${widthsArr.join(' ')} ]`);
      i = j + 1;
    }
    const scale = 1000 / font.unitsPerEm;
    w.write(
      `${cidFontObj} 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${font.postScriptName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor << /Type /FontDescriptor /FontName /${font.postScriptName} /Flags 4 /FontBBox [0 ${Math.round(-200 * scale)} ${Math.round(1000 * scale)} ${Math.round(900 * scale)}] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${fontFileObj} 0 R >> /DW 1000 /W [ ${wParts.join(' ')} ] /CIDToGIDMap /Identity >>\nendobj\n`,
    );
  }
  const type0FontObj = font ? w.beginObject() : 0;
  if (font) {
    // ToUnicode：已用字符的 gid → unicode 逆映射
    const gidToUni = new Map<number, number>();
    for (const [cp, gid] of font.cmap) if (usedGids.has(gid) && !gidToUni.has(gid)) gidToUni.set(gid, cp);
    const sortedGids = [...gidToUni.keys()].sort((a, b) => a - b);
    const bfchar: string[] = [];
    for (let k = 0; k < sortedGids.length; k += 100) {
      const chunk = sortedGids.slice(k, k + 100);
      bfchar.push(`${chunk.length} beginbfchar`);
      for (const gid of chunk) {
        bfchar.push(`<${gid.toString(16).padStart(4, '0')}> <${gidToUni.get(gid)!.toString(16).padStart(4, '0')}>`);
      }
      bfchar.push('endbfchar');
    }
    const cmap = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /Adobe-Identity-UCS def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange',
      ...bfchar,
      'endcmap',
      'CMapName currentdict /CMap defineresource pop',
      'end end',
    ].join('\n');
    const tuObj = type0FontObj + 1; // 紧跟的下一个对象号
    w.write(
      `${type0FontObj} 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /${font.postScriptName} /Encoding /Identity-H /DescendantFonts [ ${cidFontObj} 0 R ] /ToUnicode ${tuObj} 0 R >>\nendobj\n`,
    );
    w.beginObject(); // tuObj：记录正确偏移
    w.write(`${tuObj} 0 obj\n<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>\nstream\n${cmap}\nendstream\nendobj\n`);
  }
  const helveticaObj = font ? 0 : w.beginObject();
  if (!font) {
    w.write(`${helveticaObj} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);
  }
  const fontRef = font ? type0FontObj : helveticaObj;

  const pageObjs: number[] = [];
  const contentObjs: number[] = [];
  for (let p = 0; p < pageCount; p++) {
    contentObjs.push(w.beginObject());
    const c = contentOf(p);
    w.write(`${contentObjs[p]} 0 obj\n<< /Length ${Buffer.byteLength(c, 'latin1')} >>\nstream\n${c}\nendstream\nendobj\n`);
  }
  const pagesObj = w.beginObject();
  const pageKids: string[] = [];
  for (let p = 0; p < pageCount; p++) {
    pageObjs.push(w.beginObject());
    pageKids.push(`${pageObjs[p]} 0 R`);
    w.write(
      `${pageObjs[p]} 0 obj\n<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontRef} 0 R >> >> /Contents ${contentObjs[p]} 0 R >>\nendobj\n`,
    );
  }
  w.write(`${pagesObj} 0 obj\n<< /Type /Pages /Kids [ ${pageKids.join(' ')} ] /Count ${pageCount} >>\nendobj\n`);
  const catalogObj = w.beginObject();
  w.write(`${catalogObj} 0 obj\n<< /Type /Catalog /Pages ${pagesObj} 0 R >>\nendobj\n`);
  const infoObj = w.beginObject();
  w.write(`${infoObj} 0 obj\n<< /Producer (nangying-starmap) /CreationDate (D:19800101000000Z) >>\nendobj\n`);

  return {
    bytes: w.finish(catalogObj, infoObj),
    embeddedFont: font !== null,
    replacedChars: replaced.n,
    pageCount,
  };
}

/** 拉丁可编码性检查（调用方用于"仅英文/数字可用"诚实降级说明） */
export function countNonLatinChars(text: string): number {
  let n = 0;
  for (const ch of text) if (ch.charCodeAt(0) > 0xff) n += 1;
  return n;
}
