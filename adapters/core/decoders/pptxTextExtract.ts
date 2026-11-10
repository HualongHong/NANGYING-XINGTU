/**
 * PPTX 原生文本抽取（适配层，零依赖）。
 *
 * PPTX 本质是 zip：最小 zip 读取（central directory 定位 entry，local header 取数据，
 * stored 原样 / deflate 用 inflateRawSync），解析 ppt/slides/slideN.xml 按 XML 顺序
 * 提取 <a:t> 文本节点，按幻灯片数字序分页；演讲者备注（ppt/notesSlides/）按同号近似
 * 挂到对应页。输出与 PDF 解码器一致的 `=== 第N页 ===` 文本形态，保持下游 parse 兼容。
 *
 * 纯图片课件（无 a:t）抽取结果为空，由调用方降级（图片渲染 OCR 本期不做）。
 */
import { inflateRawSync } from 'node:zlib';

// ---------- 最小 zip 读取 ----------

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** 从 zip 字节中按 entry 名集合提取未压缩数据 */
export function readZipEntries(zip: Uint8Array, names: Set<string>): Map<string, Buffer> {
  const buf = Buffer.from(zip);
  const out = new Map<string, Buffer>();

  // 从尾部扫描 EOCD（签名 0x06054b50，注释长度字段之后即为文件尾）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('非法 zip：未找到中央目录结尾记录（EOCD）');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // central directory 偏移

  for (let n = 0; n < entryCount && ptr + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(ptr) !== CDIR_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;

    if (!names.has(name)) continue;
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
  }
  return out;
}

/** 列出 zip 内匹配正则的全部 entry 名（按自然数字序排序） */
export function listZipEntries(zip: Uint8Array, pattern: RegExp): string[] {
  const buf = Buffer.from(zip);
  const names: string[] = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('非法 zip：未找到中央目录结尾记录（EOCD）');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entryCount && ptr + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(ptr) !== CDIR_SIG) break;
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    if (pattern.test(name)) names.push(name);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  const num = (s: string) => Number(/(\d+)/.exec(s)?.[1] ?? 0);
  return names.sort((a, b) => num(a) - num(b));
}

// ---------- PPTX 文本提取 ----------

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'",
};

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(?:lt|gt|amp|quot|apos|#\d+);/g, (m) =>
    m.startsWith('&#') ? String.fromCodePoint(Number(m.slice(2, -1))) : XML_ENTITIES[m] ?? m,
  );
}

/** 按 XML 顺序提取 <a:t> 文本节点 */
export function extractAText(xml: string): string[] {
  const out: string[] = [];
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const text = decodeXmlEntities(m[1]).trim();
    if (text) out.push(text);
  }
  return out;
}

export interface PptxPage {
  page: number;
  texts: string[];
  notes: string[];
}

export interface PptxExtractResult {
  slides: PptxPage[];
  /** 纯图片幻灯片数（无 a:t 文本） */
  imageOnlySlides: number;
}

/** 抽取 PPTX 全部幻灯片文本（含备注） */
export function extractPptxText(pptx: Uint8Array): PptxExtractResult {
  const slideNames = listZipEntries(pptx, /^ppt\/slides\/slide\d+\.xml$/);
  const notesNames = new Set(listZipEntries(pptx, /^ppt\/notesSlides\/notesSlide\d+\.xml$/));
  const wanted = new Set([...slideNames, ...notesNames]);
  const entries = readZipEntries(pptx, wanted);

  const notesByNum = new Map<number, string[]>();
  for (const name of notesNames) {
    const num = Number(/(\d+)/.exec(name)![1]);
    const xml = entries.get(name)?.toString('utf8') ?? '';
    notesByNum.set(num, extractAText(xml));
  }

  const slides: PptxPage[] = [];
  let imageOnlySlides = 0;
  slideNames.forEach((name, idx) => {
    const xml = entries.get(name)?.toString('utf8') ?? '';
    const texts = extractAText(xml);
    if (texts.length === 0) imageOnlySlides += 1;
    slides.push({ page: idx + 1, texts, notes: notesByNum.get(idx + 1) ?? [] });
  });
  return { slides, imageOnlySlides };
}

/** 渲染为与 PDF 解码器一致的 `=== 第N页 ===` 分页文本。
 *  幻灯片内各 <a:t> 文本节点以空行分隔（视为独立要点段落），
 *  避免 parse 的折行合并把相邻要点粘成一个段落产生跨要点碎片 n-gram。 */
export function toPagedText(result: PptxExtractResult): string {
  return result.slides
    .map((slide) => {
      const body = slide.texts.join('\n\n');
      const notes = slide.notes.length > 0 ? `\n[备注] ${slide.notes.join(' ')}` : '';
      return `=== 第${slide.page}页 ===\n${body}${notes}`;
    })
    .join('\n\n');
}

// ---------- 幻灯片图片抽取（r:embed 关系，按幻灯片顺序） ----------

export interface SlideImage {
  page: number;
  index: number;
  data: Uint8Array;
  name: string;
}

export interface PptxImagesResult {
  images: SlideImage[];
  /** 跳过的非光栅对象数（emf/wmf/mp4 等，OCR 无法处理） */
  skippedNonRaster: number;
}

const RASTER_EXT = new Set(['jpeg', 'jpg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff']);

/** 解析 slide rels（r:embed → media 目标），按幻灯片顺序与 XML 内引用顺序输出图片字节 */
export function extractPptxImages(pptx: Uint8Array): PptxImagesResult {
  const slideNames = listZipEntries(pptx, /^ppt\/slides\/slide\d+\.xml$/);
  const relsNames = slideNames.map((n) =>
    n.replace('ppt/slides/slide', 'ppt/slides/_rels/slide') + '.rels',
  );
  const mediaNames = new Set(listZipEntries(pptx, /^ppt\/media\//));
  const entries = readZipEntries(
    pptx,
    new Set([...slideNames, ...relsNames, ...mediaNames]),
  );

  const out: SlideImage[] = [];
  let skippedNonRaster = 0;
  slideNames.forEach((slideName, idx) => {
    const page = idx + 1;
    const relsXml = entries.get(relsNames[idx])?.toString('utf8') ?? '';
    // Relationship：Id="rIdN" … Target="../media/imageX.png"
    const relMap = new Map<string, string>();
    const relRe = /<Relationship\b[^>]*>/g;
    let rm: RegExpExecArray | null;
    while ((rm = relRe.exec(relsXml)) !== null) {
      const tag = rm[0];
      const id = /\bId="([^"]+)"/.exec(tag)?.[1];
      const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
      if (id && target) relMap.set(id, target);
    }
    const slideXml = entries.get(slideName)?.toString('utf8') ?? '';
    const embedRe = /r:embed="([^"]+)"/g;
    let em: RegExpExecArray | null;
    let imageIdx = 0;
    while ((em = embedRe.exec(slideXml)) !== null) {
      const target = relMap.get(em[1]);
      if (!target) continue;
      // '../media/imageX.png' → 'ppt/media/imageX.png'
      const mediaName = 'ppt/' + target.replace(/^(\.\.\/)+/, '');
      const ext = mediaName.split('.').pop()?.toLowerCase() ?? '';
      if (!RASTER_EXT.has(ext)) {
        skippedNonRaster += 1; // emf/wmf/mp4 等矢量或媒体对象，OCR 无法处理
        continue;
      }
      const data = entries.get(mediaName);
      if (!data) continue;
      imageIdx += 1;
      out.push({ page, index: imageIdx, data: new Uint8Array(data), name: mediaName });
    }
  });
  return { images: out, skippedNonRaster };
}