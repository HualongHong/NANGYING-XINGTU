/**
 * 原生 PDF 文本抽取（R6-1，零运行时依赖：node:zlib）。
 *
 * 背景（真实验证，反馈链路）：PPT/Word 导出的 PDF 有真实文本层（pdftotext 可抽），
 * 但 R5 的扫描件自动探测按"≥3 页图像"误判走 OCR，对背景灰矩形图识别出乱码；
 * 且插件此前没有任何原生 PDF 文本抽取能力。本模块补上这一环。
 *
 * 实现要点（最小可用，非完整 PDF 解析）：
 *  - 对象扫描：正则找 `N G obj ... endobj`——**不解析 xref**（扫描器不需要索引）；
 *  - ObjStm：/Type /ObjStm 的 FlateDecode 流解码后按 (编号, 偏移) 头展开内嵌对象
 *    （不解 xref 流；找不到对象时该部分标 partial 跳过）；
 *  - 流解码：FlateDecode（inflateSync）；带 PNG predictor 的 /DecodeParms 跳过该流；
 *  - ToUnicode CMap：bfchar / bfrange（含数组形态），codespacerange 定码宽；
 *  - 内容流：BT/ET 内 Tj / TJ / ' / " 文本算子，按 `Tf` 切换字体做 CID→Unicode；
 *  - 页序：目录 /Pages 树 /Kids 递归（资源沿树继承合并）；无目录则按对象号排序；
 *  - 无 ToUnicode 的字体：西文 literal 按 cp1252 直用；CID 无映射跳过（partial 标注）。
 *
 * 接口：extractPdfText(data) → { text, pages, partial, charsPerPage } | null
 * （null = 不是可处理的 PDF 结构，交由下游 OCR/降级链）。
 */

import { inflateSync } from 'node:zlib';

export interface PdfTextResult {
  /** 全文（页间空行分隔） */
  text: string;
  pages: number;
  /** 有部分流/对象未能处理（跳过 predictor 流、缺 ToUnicode 的 CID 字形等） */
  partial: boolean;
  charsPerPage: number[];
}

/** 解析护栏：防怪异文件死循环/爆内存 */
const MAX_OBJECTS = 20_000;
const MAX_STREAMS = 5_000;
/** 低于此字符数视为"无实质文本层"（调用方据此决定是否走 OCR） */
export const PDF_TEXT_SUBSTANTIAL_CHARS = 100;

interface PdfObject {
  num: number;
  body: string;
  /** body 起点在整个文件中的绝对字节偏移（rawStreamOf 定位流数据用） */
  bodyStart: number;
}

interface DecodedStream {
  dict: string;
  data: Buffer;
}

// ---------- 对象扫描 ----------

function scanObjects(buf: Buffer): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const src = buf.toString('latin1');
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (objects.size >= MAX_OBJECTS) break;
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const endRel = src.indexOf('endobj', start);
    if (endRel < 0) break;
    if (!objects.has(num)) {
      objects.set(num, { num, body: src.slice(start, endRel), bodyStart: start });
    }
    re.lastIndex = endRel;
  }
  return objects;
}

/** 从对象体中提取 stream 原始字节（dict + data） */
function rawStreamOf(body: string, whole: Buffer, objStart: number): DecodedStream | null {
  const sIdx = body.indexOf('stream');
  if (sIdx < 0) return null;
  let dataStart = sIdx + 'stream'.length;
  if (body[dataStart] === '\r' && body[dataStart + 1] === '\n') dataStart += 2;
  else if (body[dataStart] === '\n' || body[dataStart] === '\r') dataStart += 1;
  // 绝对偏移：objStart 是 body 在 whole 中的起点（调用方保证）
  const absDataStart = objStart + dataStart;
  const lenM = /\/Length\s+(\d+)/.exec(body.slice(0, sIdx));
  let dataEnd: number;
  if (lenM) {
    dataEnd = absDataStart + Number(lenM[1]);
    if (dataEnd > whole.length) dataEnd = whole.length;
  } else {
    const es = whole.indexOf('endstream', absDataStart);
    dataEnd = es < 0 ? whole.length : es;
  }
  return { dict: body.slice(0, sIdx), data: whole.subarray(absDataStart, dataEnd) };
}

/** 解码流：FlateDecode；predictor / 未知过滤器返回 null（partial） */
function decodeStream(raw: DecodedStream): Buffer | null {
  if (/\/DecodeParms[\s\S]*?\/Predictor\s+[2-9]/.test(raw.dict)) return null;
  if (/\/FlateDecode/.test(raw.dict)) {
    try {
      return inflateSync(raw.data);
    } catch {
      // 尾部长度不准时尝试截断到最后一个完整块：逐步缩短重试
      for (let cut = raw.data.length - 1; cut > raw.data.length - 64 && cut > 0; cut--) {
        try { return inflateSync(raw.data.subarray(0, cut)); } catch { /* continue */ }
      }
      return null;
    }
  }
  if (!/\/Filter/.test(raw.dict)) return raw.data;
  return null;
}

// ---------- ObjStm 展开 ----------

function expandObjStms(objects: Map<number, PdfObject>, whole: Buffer): boolean {
  let partial = false;
  let expanded = 0;
  for (const obj of [...objects.values()]) {
    if (expanded >= MAX_STREAMS) { partial = true; break; }
    if (!/\/Type\s*\/ObjStm/.test(obj.body)) continue;
    const raw = rawStreamOf(obj.body, whole, obj.bodyStart);
    if (!raw) { partial = true; continue; }
    const data = decodeStream(raw);
    if (!data) { partial = true; continue; }
    const nM = /\/N\s+(\d+)/.exec(raw.dict);
    const firstM = /\/First\s+(\d+)/.exec(raw.dict);
    if (!nM || !firstM) { partial = true; continue; }
    const n = Number(nM[1]);
    const first = Number(firstM[1]);
    const header = data.toString('latin1', 0, first);
    const nums = header.match(/\d+/g) ?? [];
    for (let i = 0; i < Math.min(n, nums.length / 2); i++) {
      const num = Number(nums[i * 2]);
      const off = first + Number(nums[i * 2 + 1]);
      if (objects.has(num)) continue;
      // 对象体到下一个偏移或流尾
      const nextOff = i + 1 < Math.min(n, nums.length / 2) ? first + Number(nums[i * 2 + 3]) : data.length;
      objects.set(num, { num, body: data.toString('latin1', off, nextOff), bodyStart: 0 }); // ObjStm 内嵌对象不会是流（PDF 规范禁止）
    }
    expanded += 1;
  }
  return partial;
}

// ---------- ToUnicode CMap ----------

interface FontMap {
  /** CID → Unicode 字符串；无 CMap 时为 null（西文按 cp1252 直用） */
  cmap: Map<number, string> | null;
  /** 码宽（字节）：2 = CID 字体；1 = 简单字体 */
  width: 1 | 2;
}

function parseCMap(cmapText: string): { map: Map<number, string>; width: 1 | 2 } | null {
  const map = new Map<number, string>();
  // 码宽：codespacerange 上限 ≥ 0xFF00 视为 2 字节
  let width: 1 | 2 = 2;
  const cs = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\r?\n?endcodespacerange|begincodespacerange([\s\S]*?)endcodespacerange/.exec(cmapText);
  const csBody = cs ? (cs[3] ?? '') : '';
  const csM = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(csBody);
  if (csM && csM[2].length <= 2) width = 1;

  const hexToStr = (hex: string): string => {
    const bytes: number[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    // ToUnicode 目标为 UTF-16BE（BMP 中文/西文均覆盖）；按码元解码
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    if (bytes.length % 2 === 1) out += String.fromCharCode(bytes[bytes.length - 1]);
    return out;
  };

  // bfchar：<src> <dst>
  for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), hexToStr(m[2]));
    }
  }
  // bfrange：<lo> <hi> <dstLo>（递增）或 <lo> <hi> [<d1> <d2> ...]
  for (const block of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const line of block[1].split('\n')) {
      const arrM = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/.exec(line);
      if (arrM) {
        const lo = parseInt(arrM[1], 16);
        const dsts = [...arrM[3].matchAll(/<([0-9A-Fa-f]+)>/g)];
        dsts.forEach((d, i) => map.set(lo + i, hexToStr(d[1])));
        continue;
      }
      const incM = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(line);
      if (incM) {
        const lo = parseInt(incM[1], 16);
        const hi = parseInt(incM[2], 16);
        const dstLo = parseInt(incM[3], 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          map.set(c, hexToStr((dstLo + (c - lo)).toString(16).padStart(incM[3].length, '0')));
        }
      }
    }
  }
  return map.size > 0 ? { map, width } : null;
}

// ---------- 页树 ----------

function resolveRef(body: string, key: string): number | null {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(body);
  return m ? Number(m[1]) : null;
}

interface PageNode {
  num: number;
  /** 继承合并后的 Font 资源：资源名 → 字体对象号 */
  fonts: Map<string, number>;
  contents: number[];
}

function collectPages(
  objects: Map<number, PdfObject>,
  whole: Buffer,
): { pages: PageNode[]; partial: boolean } {
  let partial = false;
  // 目录 → Pages 根
  let catalog: PdfObject | undefined;
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Catalog\b/.test(obj.body)) { catalog = obj; break; }
  }
  const pages: PageNode[] = [];
  const visited = new Set<number>();

  const fontDictOf = (body: string): Array<[string, number]> => {
    // /Font 可能是内联字典，也可能在 /Resources <<...>> 内联块里
    const containers = [body];
    const resInline = /\/Resources\s*<<([\s\S]*?)>>/.exec(body);
    if (resInline) containers.push(resInline[1]);
    const out: Array<[string, number]> = [];
    for (const c of containers) {
      const m = /\/Font\s*<<([\s\S]*?)>>/.exec(c);
      if (!m) continue;
      for (const x of m[1].matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g)) {
        out.push([x[1], Number(x[2])]);
      }
    }
    return out;
  };

  /** /Resources 引用解析：返回合并的 Font 资源（本节点 + 继承） */
  const fontsOf = (body: string, inherited: Map<string, number>): Map<string, number> => {
    const fonts = new Map(inherited);
    const resRef = resolveRef(body, 'Resources');
    if (resRef !== null) {
      const resObj = objects.get(resRef);
      if (resObj) for (const [k, v] of fontDictOf(resObj.body)) fonts.set(k, v);
    }
    for (const [k, v] of fontDictOf(body)) fonts.set(k, v);
    return fonts;
  };

  const walk = (num: number, inheritedFonts: Map<string, number>) => {
    if (visited.has(num)) return;
    visited.add(num);
    const obj = objects.get(num);
    if (!obj) { partial = true; return; }
    const fonts = fontsOf(obj.body, inheritedFonts);
    if (/\/Type\s*\/Page\b/.test(obj.body) && !/\/Type\s*\/Pages\b/.test(obj.body)) {
      const contents: number[] = [];
      const cM = /\/Contents\s*\[([^\]]*)\]/.exec(obj.body);
      if (cM) {
        for (const r of cM[1].matchAll(/(\d+)\s+\d+\s+R/g)) contents.push(Number(r[1]));
      } else {
        const single = resolveRef(obj.body, 'Contents');
        if (single !== null) contents.push(single);
      }
      pages.push({ num, fonts, contents });
      return;
    }
    const kidsM = /\/Kids\s*\[([^\]]*)\]/.exec(obj.body);
    if (kidsM) {
      for (const r of kidsM[1].matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(r[1]), fonts);
    }
  };

  if (catalog) {
    const pagesRoot = resolveRef(catalog.body, 'Pages');
    if (pagesRoot !== null) walk(pagesRoot, new Map());
  }
  if (pages.length === 0) {
    // 退化：按对象号收集所有页对象（资源不继承——partial）
    const nums = [...objects.keys()].sort((a, b) => a - b);
    for (const num of nums) {
      const obj = objects.get(num)!;
      if (/\/Type\s*\/Page\b/.test(obj.body) && !/\/Type\s*\/Pages\b/.test(obj.body)) {
        const contents: number[] = [];
        const cM = /\/Contents\s*\[([^\]]*)\]/.exec(obj.body);
        if (cM) for (const r of cM[1].matchAll(/(\d+)\s+\d+\s+R/g)) contents.push(Number(r[1]));
        const single = resolveRef(obj.body, 'Contents');
        if (single !== null) contents.push(single);
        if (contents.length > 0) pages.push({ num, fonts: new Map(fontDictOf(obj.body)), contents });
      }
    }
    if (pages.length > 0) partial = true;
  }
  return { pages, partial };
}

// ---------- 内容流文本算子 ----------

/** 解析内容流字节，按字体映射解码文本算子 */
function extractFromContent(
  data: Buffer,
  fontOf: (name: string) => FontMap | null,
  onText: (s: string) => void,
): boolean {
  // token 扫描：/F1 12 Tf | (lit) Tj | <hex> Tj | [ ... ] TJ | (lit) ' | <hex> '
  const src = data.toString('latin1');
  let current: FontMap | null = null;
  let ok = true;
  const re = /(\/[A-Za-z0-9_.+-]+)|(\((?:\\.|[^\\()])*\))|(<[0-9A-Fa-f\s]*>)|(\[)|(\])|(-?\d+(?:\.\d+)?)|(\bT[fjJ]\b|')|(\bBT\b|\bET\b)/g;
  let m: RegExpExecArray | null;
  let stack: string[] = [];
  const decodeBytes = (bytes: Buffer): string => {
    if (!current) return '';
    if (!current.cmap) {
      // 无 CMap：西文按 cp1252
      return bytes.toString('binary').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]+/g, '');
    }
    let out = '';
    const w = current.width;
    for (let i = 0; i + w <= bytes.length; i += w) {
      const code = w === 2 ? bytes.readUInt16BE(i) : bytes[i];
      const ch = current.cmap.get(code);
      if (ch !== undefined) out += ch;
      else ok = false; // 无映射字形：partial
    }
    return out;
  };
  const decodeLiteral = (tok: string): Buffer => {
    // (abc\)def) 反转义
    const inner = tok.slice(1, -1);
    const out: number[] = [];
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '\\' && i + 1 < inner.length) {
        const c = inner[++i];
        if (c === 'n') out.push(10);
        else if (c === 'r') out.push(13);
        else if (c === 't') out.push(9);
        else if (/[0-7]/.test(c)) {
          let oct = c;
          for (let k = 0; k < 2 && i + 1 < inner.length && /[0-7]/.test(inner[i + 1]); k++) oct += inner[++i];
          out.push(parseInt(oct, 8));
        } else out.push(c.charCodeAt(0));
      } else out.push(inner.charCodeAt(i));
    }
    return Buffer.from(out);
  };
  let inTJ = false;
  let tjBuffer: string[] = [];
  while ((m = re.exec(src)) !== null) {
    if (m[7]) {
      // 算子
      const op = m[7];
      if (op === 'Tf') {
        const name = stack[stack.length - 2];
        current = name ? fontOf(name.startsWith('/') ? name.slice(1) : name) : null;
      } else if (op === 'Tj' || op === "'" || op === '"') {
        const last = stack[stack.length - 1];
        if (last) {
          if (last.startsWith('(')) onText(decodeBytes(decodeLiteral(last)));
          else if (last.startsWith('<')) {
            const hex = last.slice(1, -1).replace(/\s+/g, '');
            const bytes: number[] = [];
            for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
            onText(decodeBytes(Buffer.from(bytes)));
          }
        }
        if (op === "'") onText('\n');
      } else if (op === 'TJ') {
        if (tjBuffer.length > 0) onText(tjBuffer.join(''));
        tjBuffer = [];
        inTJ = false;
      }
      stack = [];
      continue;
    }
    if (m[6] !== undefined) { stack.push(m[6]); continue; } // 数字（位移/字号，忽略）
    if (m[4]) { inTJ = true; tjBuffer = []; continue; }
    if (m[5]) { inTJ = false; continue; }
    if (m[8]) { onText('\n'); stack = []; continue; } // BT/ET 分段
    const tok = m[1] ?? m[2] ?? m[3];
    if (!tok) continue;
    if (inTJ && (tok.startsWith('(') || tok.startsWith('<'))) {
      if (tok.startsWith('(')) tjBuffer.push(decodeBytes(decodeLiteral(tok)));
      else {
        const hex = tok.slice(1, -1).replace(/\s+/g, '');
        const bytes: number[] = [];
        for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
        tjBuffer.push(decodeBytes(Buffer.from(bytes)));
      }
    } else {
      stack.push(tok);
    }
  }
  return ok;
}

// ---------- 主入口 ----------

export function extractPdfText(data: Uint8Array): PdfTextResult | null {
  const whole = Buffer.from(data);
  if (whole.length < 8 || !whole.subarray(0, 5).toString('latin1').startsWith('%PDF-')) return null;
  let partial = false;
  const objects = scanObjects(whole);
  if (objects.size === 0) return null;
  if (expandObjStms(objects, whole)) partial = true;

  // 字体对象 → FontMap（缓存）
  const fontCache = new Map<number, FontMap | null>();
  const fontMapOf = (num: number): FontMap | null => {
    if (fontCache.has(num)) return fontCache.get(num)!;
    let fm: FontMap | null = null;
    const obj = objects.get(num);
    if (obj) {
      const isCID = /\/Subtype\s*\/(Type0|CIDFontType)/.test(obj.body) || /\/DescendantFonts/.test(obj.body);
      const tu = resolveRef(obj.body, 'ToUnicode');
      if (tu !== null) {
        const tuObj = objects.get(tu);
        const raw = tuObj ? rawStreamOf(tuObj.body, whole, tuObj.bodyStart) : null;
        const dec = raw ? decodeStream(raw) : null;
        if (dec) {
          const parsed = parseCMap(dec.toString('latin1'));
          if (parsed) fm = { cmap: parsed.map, width: parsed.width };
        }
        if (!fm) partial = true;
      }
      if (!fm) fm = { cmap: null, width: isCID ? 2 : 1 };
    }
    fontCache.set(num, fm);
    return fm;
  };

  const { pages, partial: pagesPartial } = collectPages(objects, whole);
  if (pagesPartial) partial = true;
  if (pages.length === 0) return null;

  const pageTexts: string[] = [];
  const charsPerPage: number[] = [];
  let streamCount = 0;
  for (const page of pages) {
    const parts: string[] = [];
    for (const cNum of page.contents) {
      if (streamCount >= MAX_STREAMS) { partial = true; break; }
      const cObj = objects.get(cNum);
      if (!cObj) { partial = true; continue; }
      const raw = rawStreamOf(cObj.body, whole, cObj.bodyStart);
      if (!raw) { partial = true; continue; }
      const dec = decodeStream(raw);
      if (!dec) { partial = true; continue; }
      streamCount += 1;
      let ok = true;
      try {
        ok = extractFromContent(
          dec,
          (name) => {
            const fNum = page.fonts.get(name);
            return fNum === undefined ? null : fontMapOf(fNum);
          },
          (s) => { if (s) parts.push(s); },
        );
      } catch {
        ok = false; // 单流解析异常不拖垮整册
      }
      if (!ok) partial = true;
    }
    // 清理：合并相邻片段，空行分页
    const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    pageTexts.push(text);
    charsPerPage.push(text.length);
  }
  const text = pageTexts.join('\n\n');
  if (text.length === 0) return null;
  return { text, pages: pages.length, partial, charsPerPage };
}
