/**
 * OOXML 渲染（R4-3，反馈 a P1-5：补 PPTX/讲稿导出）。
 *
 * 零依赖、纯 TS（core 层无 Node API）：生成最小可用的 DOCX（讲稿/教案）与
 * PPTX（分镜逐页）OOXML 部件（PackageFileEntry 路径 + XML 文本）。
 * 适配层（packageWriter.toZipBuffer）把这些部件打成真实 zip 产物（stored、
 * 固定时间戳），同输入同字节（确定性）。
 *
 * DOCX 部件：[Content_Types].xml / _rels/.rels / word/document.xml / word/styles.xml
 * PPTX 部件：presentation + slideMaster + slideLayout + theme + slides（公开最小结构）
 */
import type { TeachingScript } from './generateTeachingScript.js';
import type { PackageFileEntry } from './exportCoursePackage.js';

// ---------- XML 转义 ----------

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------- DOCX（讲稿/教案） ----------

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
</w:styles>`;

function wP(text: string, style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

// ---------- R14：表格格子级 API（colSpan/rowSpan，对齐 pdfRender 的 PdfCell 设计） ----------

/**
 * docx 表格格子：纯字符串格子向后兼容（等价为 { text }）。
 * colSpan → w:gridSpan；rowSpan → w:vMerge（首格 restart，覆盖格空 tc + vMerge continue——
 * Word 校验要求覆盖格仍保留 tc 标签）；align=center → 段落 w:jc 居中（缺省左对齐）。
 */
export interface OoxmlCell {
  text: string;
  colSpan?: number;
  rowSpan?: number;
  align?: 'left' | 'center';
}
export type OoxmlRow = Array<string | OoxmlCell>;

const DOCX_TBL_PR = `<w:tblPr><w:tblW w:w="0" w:type="auto"/>` +
  `<w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/>` +
  `<w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/>` +
  `<w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>`;

/** 通用 docx 表格（含合并格）；无 span 的纯字符串行与旧分镜表格逐字节一致 */
export function wTable(rows: OoxmlRow[]): string {
  const norm = (c: string | OoxmlCell): OoxmlCell => (typeof c === 'string' ? { text: c } : c);
  const raw = rows.map((r) => r.map(norm));
  const anchors: Array<{ cell: OoxmlCell; r: number; c: number }> = [];
  const anchorOf: number[][] = [];
  raw.forEach((row, r) => {
    anchorOf[r] = anchorOf[r] ?? [];
    let c = 0;
    for (const cell of row) {
      while (anchorOf[r][c] !== undefined) c++; // 跳过被上方 rowSpan 覆盖的列
      const cs = Math.max(1, Math.floor(cell.colSpan ?? 1));
      const rs = Math.max(1, Math.floor(cell.rowSpan ?? 1));
      const idx = anchors.length;
      anchors.push({ cell, r, c });
      for (let dr = 0; dr < rs; dr++) {
        anchorOf[r + dr] = anchorOf[r + dr] ?? [];
        for (let dc = 0; dc < cs; dc++) anchorOf[r + dr][c + dc] = idx;
      }
      c += cs;
    }
  });
  const trXml = raw.map((row, r) => {
    const tcs: string[] = [];
    for (let c = 0; anchorOf[r][c] !== undefined; c++) {
      const a = anchors[anchorOf[r][c]];
      if (a.r !== r || a.c !== c) {
        // 同 rowSpan 覆盖格（跨行）：空 tc + vMerge continue（Word 校验要求保留 tc 标签）
        if (a.r !== r) {
          tcs.push('<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:vMerge/></w:tcPr>' +
            '<w:p><w:r><w:t xml:space="preserve"></w:t></w:r></w:p></w:tc>');
        }
        // 同行 colSpan 覆盖位：gridSpan 已吸收，不输出 tc
        continue;
      }
      const { cell } = a;
      let tcPr = '';
      if (cell.colSpan && cell.colSpan > 1) tcPr += `<w:gridSpan w:val="${cell.colSpan}"/>`;
      if (cell.rowSpan && cell.rowSpan > 1) tcPr += '<w:vMerge w:val="restart"/>';
      const pPr = cell.align === 'center' ? '<w:pPr><w:jc w:val="center"/></w:pPr>' : '';
      tcs.push(`<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>${tcPr}</w:tcPr>` +
        `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(cell.text)}</w:t></w:r></w:p></w:tc>`);
    }
    return `<w:tr>${tcs.join('')}</w:tr>`;
  });
  return `<w:tbl>${DOCX_TBL_PR}${trXml.join('')}</w:tbl>`;
}

/** 讲稿 DOCX 部件：课程标题 → 每课时（标题 + 分镜表：环节/时长/口播）；extraTables 附加格子级表格（R14） */
export function buildHandoutDocxParts(
  script: TeachingScript,
  title: string,
  extraTables?: Array<{ title?: string; rows: OoxmlRow[] }>,
): PackageFileEntry[] {
  const body: string[] = [wP(title, 'Title')];
  for (const lesson of script.storyboardScript) {
    body.push(wP(lesson.title, 'Heading1'));
    body.push(wTable([
      ['环节', '时长(分钟)', '口播稿'],
      ...lesson.scenes.map((s): OoxmlRow => [s.phase, String(s.minutes), s.voiceover]),
    ]));
  }
  for (const t of extraTables ?? []) {
    body.push(wP(t.title ?? '表格', 'Heading2'));
    body.push(wTable(t.rows));
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>
</w:document>`;
  return [
    {
      path: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
    },
    {
      path: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    { path: 'word/document.xml', content: document },
    { path: 'word/styles.xml', content: DOCX_STYLES },
  ];
}

// ---------- PPTX（分镜逐页） ----------

const PPTX_THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="nangying">
<a:themeElements><a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F3864"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme></a:themeElements></a:theme>`;

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const MASTER_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster';
const LAYOUT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';
const THEME_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme';

function slideXml(title: string, bullets: string[]): string {
  const bulletParas = bullets
    .map((b) =>
      `<a:p><a:pPr marL="342900" indent="-171450"><a:buChar char="•"/></a:pPr>` +
      `<a:r><a:rPr lang="zh-CN" dirty="0"/><a:t>${escapeXml(b)}</a:t></a:r></a:p>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" dirty="0"/><a:t>${escapeXml(title)}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="0"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${bulletParas || '<a:p><a:r><a:t></a:t></a:p>'}</p:txBody></p:sp>
</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>
</p:sld>`;
}

/** 分镜 PPTX 部件：每课时一页（标题=课时，要点=各 scene 口播摘要） */
export function buildSlidesPptxParts(script: TeachingScript, title: string): PackageFileEntry[] {
  const slides: Array<{ title: string; bullets: string[] }> = [
    { title, bullets: script.storyboardScript.map((l) => l.title) },
    ...script.storyboardScript.map((lesson) => ({
      title: lesson.title,
      bullets: lesson.scenes.map((s) => `${s.phase}（${s.minutes}分钟）：${s.voiceover}`),
    })),
  ];
  const slideOverrides = slides
    .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join('');
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slideOverrides}
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;
  const slideIds = slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
    .join('');
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${slideIds}</p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
  const presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}">
<Relationship Id="rId1" Type="${MASTER_REL}" Target="slideMasters/slideMaster1.xml"/>
${slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="${SLIDE_REL}" Target="slides/slide${i + 1}.xml"/>`).join('')}
</Relationships>`;
  const slideMaster = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;
  const masterRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}">
<Relationship Id="rId1" Type="${LAYOUT_REL}" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="${THEME_REL}" Target="../theme/theme1.xml"/>
</Relationships>`;
  const slideLayout = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" type="titleAndObj">
<p:cSld name="标题与内容"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
  const layoutRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}">
<Relationship Id="rId1" Type="${MASTER_REL}" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;

  const parts: PackageFileEntry[] = [
    { path: '[Content_Types].xml', content: contentTypes },
    { path: '_rels/.rels', content: rootRels },
    { path: 'ppt/presentation.xml', content: presentation },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slideMasters/slideMaster1.xml', content: slideMaster },
    { path: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', content: masterRels },
    { path: 'ppt/slideLayouts/slideLayout1.xml', content: slideLayout },
    { path: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', content: layoutRels },
    { path: 'ppt/theme/theme1.xml', content: PPTX_THEME },
  ];
  slides.forEach((s, i) => {
    parts.push({ path: `ppt/slides/slide${i + 1}.xml`, content: slideXml(s.title, s.bullets) });
    parts.push({
      path: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}">
<Relationship Id="rId1" Type="${LAYOUT_REL}" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
    });
  });
  return parts;
}
