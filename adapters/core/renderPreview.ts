/**
 * 结构化版面预览（render_preview，技能 #27，R8-1）。
 *
 * 背景（反馈 a N2）：沙箱内无法渲染 docx/pdf，"文件与扩展名不符"类问题反复出现。
 * 真栅格化零依赖不可行——本模块产出**结构化预览报告**：
 *  - 类型识别：魔数优先（PK→按 zip 内部 word/ppt/xl 判别；%PDF→pdf），扩展名交叉核验，
 *    **扩展名与内容不符时显著标注**（contentMismatch=true，即反馈痛点）；
 *  - docx：标题大纲（pStyle Heading 层级）、段落/表格统计、表格维度+表头首行、分节数；
 *  - pptx：每页标题+要点数、备注有无、图片/媒体计数；
 *  - pdf：页数、每页文本字符量（复用 pdfTextExtract）、文本层/图像页判定、OCR 需求建议；
 *  - xlsx：sheet 名/行列数（dimension 解析）。
 * detailLevel：summary（类型+总览）/ outline（+大纲或页标题）/ full（+截断文本预览）。
 */
import {
  readZipEntries,
  listZipEntries,
  extractAText,
} from './decoders/pptxTextExtract.js';
import { extractPdfText } from './decoders/pdfTextExtract.js';
import { extractPdfImages } from './decoders/pdfImageExtract.js';

export type PreviewFileType = 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'unknown';
export type DetailLevel = 'summary' | 'outline' | 'full';

export interface RenderPreviewInput {
  /** 文件路径（适配层读取）或 { content, materialType } 已解码对象 */
  file: string | { content: string; materialType?: string };
  detailLevel?: DetailLevel;
}

export interface DocxPreview {
  outline: Array<{ level: number; text: string }>;
  paragraphs: number;
  tables: Array<{ rows: number; cols: number; header: string[] }>;
  sections: number;
  /** full 级：非标题段落截断预览 */
  previews?: string[];
}

export interface PptxSlidePreview {
  page: number;
  title: string | null;
  textItems: number;
  hasNotes: boolean;
  preview?: string;
}

export interface PptxPreview {
  slides: PptxSlidePreview[];
  imageCount: number;
  mediaCount: number;
}

export interface PdfPreview {
  pages: number;
  charsPerPage: number[];
  textLayer: boolean;
  totalImages: number;
  /** 扫描件特征（≥3 图且文本少）→ 建议 OCR */
  ocrSuggested: boolean;
  previews?: string[];
}

export interface XlsxPreview {
  sheets: Array<{ name: string; rows: number; cols: number }>;
}

export interface RenderPreviewReport {
  fileType: PreviewFileType;
  /** 声明的类型（扩展名/materialType），与魔数识别交叉核验 */
  claimedType: string;
  /** 扩展名与内容不符（显著标注） */
  contentMismatch: boolean;
  detailLevel: DetailLevel;
  docx?: DocxPreview;
  pptx?: PptxPreview;
  pdf?: PdfPreview;
  xlsx?: XlsxPreview;
}

const EXT_TO_TYPE: Record<string, PreviewFileType> = {
  docx: 'docx', pptx: 'pptx', ppt: 'pptx', xlsx: 'xlsx', pdf: 'pdf',
};

function claimedOf(input: RenderPreviewInput): { type: PreviewFileType; claimed: string } {
  if (typeof input.file === 'string') {
    const ext = input.file.slice(input.file.lastIndexOf('.') + 1).toLowerCase();
    return { type: EXT_TO_TYPE[ext] ?? 'unknown', claimed: ext };
  }
  const mt = (input.file.materialType ?? '').toLowerCase();
  return { type: EXT_TO_TYPE[mt] ?? 'unknown', claimed: mt || 'unknown' };
}

/** 魔数 + zip 内部判别真实类型 */
export function detectType(data: Uint8Array): PreviewFileType {
  if (data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && [3, 5, 7].includes(data[2])) {
    try {
      const names = new Set([
        ...listZipEntries(data, /^word\/document\.xml$/),
        ...listZipEntries(data, /^ppt\/presentation\.xml$/),
        ...listZipEntries(data, /^xl\/workbook\.xml$/),
      ]);
      if (names.has('word/document.xml')) return 'docx';
      if (names.has('ppt/presentation.xml')) return 'pptx';
      if (names.has('xl/workbook.xml')) return 'xlsx';
    } catch { /* zip 结构异常 → unknown */ }
    return 'unknown';
  }
  if (data.length > 5 && Buffer.from(data.subarray(0, 5)).toString('latin1') === '%PDF-') return 'pdf';
  return 'unknown';
}

// ---------- docx ----------

function analyzeDocx(data: Uint8Array, level: DetailLevel): DocxPreview | null {
  try {
    const entries = readZipEntries(data, new Set(['word/document.xml']));
    const xml = entries.get('word/document.xml')?.toString('utf8') ?? '';
    if (!xml) return null;
    const outline: Array<{ level: number; text: string }> = [];
    const previews: string[] = [];
    let paragraphs = 0;
    const paraRe = /<w:p[\s>][\s\S]*?<\/w:p>/g;
    let m: RegExpExecArray | null;
    while ((m = paraRe.exec(xml)) !== null) {
      const p = m[0];
      const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
      const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
        .map((x) => x[1]).join('').trim();
      if (!text) continue;
      paragraphs += 1;
      const headM = /^(?:Heading|标题)(\d)$/i.exec(style) ?? (style === 'Title' ? ['', '0'] : null);
      if (headM) {
        outline.push({ level: Number(headM[1]) + 1, text });
      } else if (level === 'full' && previews.length < 30) {
        previews.push(text.length > 120 ? text.slice(0, 120) + '…' : text);
      }
    }
    const tables: DocxPreview['tables'] = [];
    const tblRe = /<w:tbl[\s>][\s\S]*?<\/w:tbl>/g;
    while ((m = tblRe.exec(xml)) !== null) {
      const rows = [...m[0].matchAll(/<w:tr[\s>]/g)].length;
      const firstRow = /<w:tr[\s>][\s\S]*?<\/w:tr>/.exec(m[0])?.[0] ?? '';
      const header = [...firstRow.matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)]
        .map((tc) => [...tc[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join('').trim());
      tables.push({ rows, cols: header.length, header });
      if (level === 'summary' && tables.length >= 5) break;
    }
    const sections = (xml.match(/<w:sectPr(?:[\s>]|\/)/g) ?? []).length;
    return {
      outline: level === 'summary' ? outline.slice(0, 10) : outline,
      paragraphs,
      tables: level === 'summary' ? tables.slice(0, 5) : tables,
      sections,
      ...(level === 'full' ? { previews } : {}),
    };
  } catch {
    return null;
  }
}

// ---------- pptx ----------

function analyzePptx(data: Uint8Array, level: DetailLevel): PptxPreview | null {
  try {
    const slideNames = listZipEntries(data, /^ppt\/slides\/slide\d+\.xml$/);
    const notesNames = new Set(listZipEntries(data, /^ppt\/notesSlides\/notesSlide\d+\.xml$/));
    const mediaNames = listZipEntries(data, /^ppt\/media\//);
    const wanted = new Set([...slideNames, ...notesNames]);
    const entries = readZipEntries(data, wanted);
    const num = (s: string) => Number(/(\d+)/.exec(s)?.[1] ?? 0);
    const slides: PptxSlidePreview[] = slideNames.map((name) => {
      const page = num(name);
      const xml = entries.get(name)?.toString('utf8') ?? '';
      const texts = extractAText(xml);
      return {
        page,
        title: texts[0] ?? null,
        textItems: texts.length,
        hasNotes: notesNames.has(`ppt/notesSlides/notesSlide${page}.xml`),
        ...(level === 'full' ? { preview: texts.join(' / ').slice(0, 150) } : {}),
      };
    });
    const imageCount = mediaNames.filter((n) => /\.(jpe?g|png|gif|bmp|webp|tiff?)$/i.test(n)).length;
    const mediaCount = mediaNames.length - imageCount;
    return { slides, imageCount, mediaCount };
  } catch {
    return null;
  }
}

// ---------- pdf ----------

function analyzePdf(data: Uint8Array, level: DetailLevel): PdfPreview | null {
  try {
    const text = extractPdfText(data);
    const { images } = extractPdfImages(data);
    const pages = text?.pages ?? 0;
    const charsPerPage = text?.charsPerPage ?? [];
    const totalChars = charsPerPage.reduce((a, b) => a + b, 0);
    const textLayer = !!text && totalChars > 100;
    const ocrSuggested = !textLayer && images.length >= 3;
    return {
      pages,
      charsPerPage: level === 'summary' ? charsPerPage.slice(0, 10) : charsPerPage,
      textLayer,
      totalImages: images.length,
      ocrSuggested,
      ...(level === 'full' && text ? {
        previews: text.text.split('\n\n').map((p) => p.replace(/\n+/g, ' ')).filter(Boolean)
          .slice(0, 20).map((p) => (p.length > 120 ? p.slice(0, 120) + '…' : p)),
      } : {}),
    };
  } catch {
    return null;
  }
}

// ---------- xlsx ----------

function analyzeXlsx(data: Uint8Array, _level: DetailLevel): XlsxPreview | null {
  try {
    const sheetFiles = listZipEntries(data, /^xl\/worksheets\/sheet\d+\.xml$/);
    const entries = readZipEntries(data, new Set(['xl/workbook.xml', ...sheetFiles]));
    const workbook = entries.get('xl/workbook.xml')?.toString('utf8') ?? '';
    const names = [...workbook.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((m) => m[1]);
    const num = (s: string) => Number(/(\d+)/.exec(s)?.[1] ?? 0);
    const sheets = sheetFiles.sort((a, b) => num(a) - num(b)).map((f: string, i: number) => {
      const xml = entries.get(f)?.toString('utf8') ?? '';
      const dim = /<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"/.exec(xml);
      return {
        name: names[i] ?? `Sheet${i + 1}`,
        cols: dim ? dim[2].split('').reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) : 0,
        rows: dim ? Number(dim[3]) : 0,
      };
    });
    return { sheets };
  } catch {
    return null;
  }
}

// ---------- 主入口 ----------

export function renderPreviewBytes(
  data: Uint8Array,
  input: { detailLevel?: DetailLevel; claimed?: { type: PreviewFileType; claimed: string } },
): RenderPreviewReport {
  const level: DetailLevel = input.detailLevel === 'outline' || input.detailLevel === 'full'
    ? input.detailLevel
    : 'summary';
  const claimed = input.claimed ?? { type: 'unknown' as PreviewFileType, claimed: 'unknown' };
  const actual = detectType(data);
  const report: RenderPreviewReport = {
    fileType: actual,
    claimedType: claimed.claimed,
    contentMismatch: actual !== 'unknown' && claimed.type !== 'unknown' && claimed.type !== actual,
    detailLevel: level,
  };
  if (actual === 'docx') report.docx = analyzeDocx(data, level) ?? undefined;
  if (actual === 'pptx') report.pptx = analyzePptx(data, level) ?? undefined;
  if (actual === 'pdf') report.pdf = analyzePdf(data, level) ?? undefined;
  if (actual === 'xlsx') report.xlsx = analyzeXlsx(data, level) ?? undefined;
  return report;
}
