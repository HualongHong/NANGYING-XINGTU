/**
 * DOCX 原生文本抽取（适配层，零依赖）。
 *
 * DOCX 本质是 zip（复用 pptxTextExtract 的最小 zip 读取）：解析 word/document.xml，
 * 按 XML 顺序提取段落 <w:p> 内的 <w:t> 文本节点（run 拼接为一段），
 * 表格 <w:tbl> 逐行 <w:tr>、逐格 <w:tc> 以 " | " 连接成文本行，保留段落与表格结构。
 *
 * 背景：纯文本 docx（python-docx 生成、44KB 无图片）此前落入二进制解码链
 * （本地 OCR 对 zip 字节易把进程打挂，实测 Connection closed 2/2）；
 * 原生抽取让常规文字讲义/教案走文本管线，OCR 仅兜底纯图片文档。
 */
import { readZipEntries, decodeXmlEntities } from './pptxTextExtract.js';

/** 提取 <w:p> 段落内的全部 <w:t> 文本（run 拼接；<w:tab/>→制表符，<w:br/>→换行） */
function paragraphText(pXml: string): string {
  const texts: string[] = [];
  const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(pXml)) !== null) {
    if (m[1] !== undefined) {
      const t = decodeXmlEntities(m[1]);
      if (t) texts.push(t);
    } else if (/<w:tab/.test(m[0])) {
      texts.push('\t');
    } else {
      texts.push('\n');
    }
  }
  return texts.join('').trim();
}

/** 表格 → 文本行（行内单元格以 " | " 连接；单元格内多段落以空格连接） */
function tableLines(tblXml: string): string[] {
  const lines: string[] = [];
  const rowRe = /<w:tr[\s>][\s\S]*?<\/w:tr>/g;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(tblXml)) !== null) {
    const cells: string[] = [];
    const cellRe = /<w:tc[\s>][\s\S]*?<\/w:tc>/g;
    let cell: RegExpExecArray | null;
    while ((cell = cellRe.exec(row[0])) !== null) {
      const paras: string[] = [];
      const pRe = /<w:p[\s>][\s\S]*?<\/w:p>/g;
      let p: RegExpExecArray | null;
      while ((p = pRe.exec(cell[0])) !== null) {
        const t = paragraphText(p[0]);
        if (t) paras.push(t);
      }
      cells.push(paras.join(' '));
    }
    const line = cells.map((c) => c.trim()).join(' | ').trim();
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * DOCX → 纯文本（段落一行、表格逐行 " | " 分隔）。
 * 抛错表示不是可解析的 docx（调用方降级到 OCR 解码链）。
 */
export function extractDocxText(docx: Uint8Array): string {
  const entries = readZipEntries(docx, new Set(['word/document.xml']));
  const xml = entries.get('word/document.xml')?.toString('utf8') ?? '';
  if (!xml) throw new Error('未找到 word/document.xml（非标准 docx）');

  const body = /<w:body[\s>][\s\S]*<\/w:body>/.exec(xml)?.[0] ?? xml;
  const lines: string[] = [];
  // 顶层块级元素按 XML 顺序：段落与表格（表格单元格内的 <w:p> 由 tableLines 消费）
  const blockRe = /<w:tbl[\s>][\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>/g;
  let b: RegExpExecArray | null;
  while ((b = blockRe.exec(body)) !== null) {
    if (b[0].startsWith('<w:tbl')) {
      lines.push(...tableLines(b[0]));
    } else {
      const t = paragraphText(b[0]);
      if (t) lines.push(t);
    }
  }
  return lines.join('\n');
}
