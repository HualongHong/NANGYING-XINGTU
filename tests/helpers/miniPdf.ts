/**
 * 测试共用：内存最小 PDF 构造 helper（有效 xref，供 pdfTextExtract 的对象扫描器消费）。
 * 支持：字典对象、FlateDecode 流对象、原始流对象；页/字体/资源按最小结构组织。
 */
import { deflateSync } from 'node:zlib';

export interface PdfObjSpec {
  num: number;
  /** 字典内部条目（不带外层 << >>；流对象则为流前字典条目） */
  dict: string;
  /** 流数据（缺省为无流对象） */
  stream?: Buffer;
  /** true 时 stream 经 FlateDecode 压缩 */
  flate?: boolean;
}

/** 组装线性 PDF（对象按 num 升序，附合法 xref/trailer） */
export function buildPdf(specs: PdfObjSpec[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  const offsets: Array<{ num: number; off: number }> = [];
  const sorted = [...specs].sort((a, b) => a.num - b.num);
  for (const s of sorted) {
    offsets.push({ num: s.num, off: Buffer.concat(parts).length });
    if (s.stream) {
      const data = s.flate ? deflateSync(s.stream) : s.stream;
      parts.push(
        Buffer.from(`${s.num} 0 obj\n<< ${s.dict} /Length ${data.length} >>\nstream\n`),
        data,
        Buffer.from('\nendstream\nendobj\n'),
      );
    } else {
      parts.push(Buffer.from(`${s.num} 0 obj\n<< ${s.dict} >>\nendobj\n`));
    }
  }
  const xrefStart = Buffer.concat(parts).length;
  const max = Math.max(...sorted.map((s) => s.num));
  const rows: string[] = [];
  for (let n = 1; n <= max; n++) {
    const o = offsets.find((x) => x.num === n);
    rows.push(o ? `${String(o.off).padStart(10, '0')} 00000 n ` : '0000000000 65535 f ');
  }
  parts.push(
    Buffer.from(`xref\n0 ${max + 1}\n0000000000 65535 f \n${rows.join('\n')}\n`),
    Buffer.from(`trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`),
  );
  return Buffer.concat(parts);
}

/** 标准 14 字体之外的 CID 字体 + ToUnicode（bfchar 映射到中文） */
export function cidFontWithToUnicode(fontNum: number, cmapNum: number, bfchar: Array<[number, string]>): PdfObjSpec[] {
  const cmapBody = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    `${bfchar.length} beginbfchar`,
    ...bfchar.map(([src, dst]) => `<${src.toString(16).padStart(2, '0')}> <${dst.charCodeAt(0).toString(16).padStart(4, '0')}>`),
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end end',
  ].join('\n');
  return [
    {
      num: cmapNum,
      dict: '/Filter /FlateDecode',
      stream: Buffer.from(cmapBody, 'latin1'),
      flate: true,
    },
    {
      num: fontNum,
      dict: `/Type /Font /Subtype /Type0 /BaseFont /TestFont /Encoding /Identity-H /ToUnicode ${cmapNum} 0 R`,
    },
  ];
}

/** 内容流：一段 BT/F1/Tj（hex 串） */
export function contentStream(contentNum: number, hexCodes: string, fontName = 'F1'): PdfObjSpec {
  const stream = Buffer.from(`BT /${fontName} 24 Tf <${hexCodes}> Tj ET`, 'latin1');
  return { num: contentNum, dict: '/Filter /FlateDecode', stream, flate: true };
}

/** 最小假 JPEG（DCTDecode 图像对象，模拟"每页背景图"） */
export function jpegImageObject(num: number): PdfObjSpec {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9]);
  return { num, dict: '/Subtype /Image /Filter /DCTDecode /Width 10 /Height 10 /ColorSpace /DeviceRGB /BitsPerComponent 8', stream: jpeg };
}
