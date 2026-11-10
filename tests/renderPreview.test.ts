import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectType, renderPreviewBytes } from '../adapters/core/renderPreview.js';
import { buildSlidesPptxParts } from '../core/course/ooxmlRender.js';
import { generateTeachingScript } from '../core/course/generateTeachingScript.js';
import { buildMiniZip } from './helpers/miniPptx.js';
import { buildPdf as buildMiniTextPdf, cidFontWithToUnicode, contentStream } from './helpers/miniPdf.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import type { CourseStructure } from '../core/course/designCourseStructure.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 带标题样式与表格的最小 docx（document.xml 手写，styles 引用 Heading1/2） */
function docxFixture(): Buffer {
  const documentXml = `<?xml version="1.0"?>
<w:document xmlns:w="w"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 种群生态学</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>1.1 种群密度</w:t></w:r></w:p>
<w:p><w:r><w:t>种群密度是种群最基本的数量特征，决定调查方法的选择。</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>含义</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>种群密度</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>单位面积个体数</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:sectPr/>
</w:body></w:document>`;
  return buildMiniZip([
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

function miniPdfFixture(): Buffer {
  const fonts = cidFontWithToUnicode(5, 6, [
    [0x21, '种'], [0x22, '群'], [0x23, '密'], [0x24, '度'],
  ]);
  return buildMiniTextPdf([
    { num: 1, dict: '/Type /Catalog /Pages 2 0 R' },
    { num: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
    { num: 3, dict: '/Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R' },
    ...fonts,
    contentStream(7, '21222324'),
  ]);
}

async function pptxFixture(): Promise<Buffer> {
  const structure: CourseStructure = {
    courseScript: { title: '生态学', audience: '本科生', totalMinutes: 4, modules: [{ id: 'm1', title: '生态学', minutes: 4, lessonIds: ['l1'] }] },
    teachingStructure: [{
      id: 'm1', title: '生态学', sectionIds: [], minutes: 4,
      lessons: [{
        id: 'l1', title: '种群密度', moduleId: 'm1', sectionIds: [], conceptIds: [], minutes: 4,
        phases: [{ kind: '导入', minutes: 1, conceptIds: [] }, { kind: '讲解', minutes: 3, conceptIds: [] }],
        assessmentPoints: [],
      }],
    }],
    teachingFlow: { steps: [], edges: [] },
  };
  const script = (await generateTeachingScript({ structure })).data!;
  const parts = buildSlidesPptxParts(script, '生态学');
  return buildMiniZip(parts.map((p) => ({ name: p.path, data: Buffer.from(p.content, 'utf8') })));
}

describe('R8-1 render_preview：类型识别与交叉核验', () => {
  it('魔数判别：docx/pptx/pdf；未知 → unknown', async () => {
    expect(detectType(new Uint8Array(docxFixture()))).toBe('docx');
    expect(detectType(new Uint8Array(await pptxFixture()))).toBe('pptx');
    expect(detectType(new Uint8Array(miniPdfFixture()))).toBe('pdf');
    expect(detectType(new Uint8Array([1, 2, 3, 4]))).toBe('unknown');
  });

  it('扩展名与内容不符：contentMismatch 显著标注（反馈痛点）', async () => {
    // docx 内容命名为 .pdf
    const report = renderPreviewBytes(new Uint8Array(docxFixture()), {
      claimed: { type: 'pdf', claimed: 'pdf' },
    });
    expect(report.fileType).toBe('docx');
    expect(report.contentMismatch).toBe(true);
    expect(report.docx?.outline[0]).toMatchObject({ level: 2, text: '第一章 种群生态学' });
  });

  it('docx 预览：Heading 大纲层级、表格维度+表头、分节数', () => {
    const report = renderPreviewBytes(new Uint8Array(docxFixture()), {});
    const d = report.docx!;
    expect(d.outline.map((o) => `${o.level}:${o.text}`)).toEqual(['2:第一章 种群生态学', '3:1.1 种群密度']);
    expect(d.paragraphs).toBeGreaterThanOrEqual(3);
    expect(d.tables).toEqual([{ rows: 2, cols: 2, header: ['指标', '含义'] }]);
    expect(d.sections).toBe(1);
  });

  it('pptx 预览：每页标题/要点数、备注、媒体计数', async () => {
    const report = renderPreviewBytes(new Uint8Array(await pptxFixture()), { detailLevel: 'outline' });
    const p = report.pptx!;
    expect(p.slides.length).toBe(2); // 封面 + 1 课时
    expect(p.slides[0].title).toBe('生态学');
    expect(p.slides[0].textItems).toBeGreaterThan(0);
    expect(p.slides.every((s) => !s.hasNotes)).toBe(true);
    expect(p.imageCount).toBe(0);
  });

  it('pdf 预览：页数/每页字符量/文本层判定', () => {
    const report = renderPreviewBytes(new Uint8Array(miniPdfFixture()), {});
    const p = report.pdf!;
    expect(p.pages).toBe(1);
    expect(p.charsPerPage).toEqual([4]);
    expect(p.textLayer).toBe(false); // 4 字符 < 100 阈值
    expect(p.ocrSuggested).toBe(false); // 无图像
  });

  it('full 级附截断预览；适配器端到端（真实 docx 文件真跑）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ny-preview-'));
    dirs.push(dir);
    const docxPath = join(dir, '教案.docx');
    writeFileSync(docxPath, docxFixture());
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('render_preview', {
      inputs: { file: docxPath, detailLevel: 'full' },
    });
    expect(r.level).toBe('full');
    const data = r.data as {
      fileType: string;
      contentMismatch: boolean;
      docx: { outline: unknown[]; previews?: string[] };
    };
    expect(data.fileType).toBe('docx');
    expect(data.contentMismatch).toBe(false);
    expect(data.docx.previews?.length).toBeGreaterThan(0);
    // 不符文件 → degraded + 显著说明
    const badPath = join(dir, '伪装.pdf');
    writeFileSync(badPath, docxFixture());
    const r2 = await adapter.invokeSkill('render_preview', { inputs: { file: badPath } });
    expect(r2.level).toBe('degraded');
    expect(r2.degradationNote).toContain('扩展名与内容不符');
    // 无法识别 → unavailable
    const junkPath = join(dir, 'junk.pdf');
    writeFileSync(junkPath, Buffer.from('not a pdf at all'));
    const r3 = await adapter.invokeSkill('render_preview', { inputs: { file: junkPath } });
    expect(r3.level).toBe('unavailable');
  }, 30000);
});
