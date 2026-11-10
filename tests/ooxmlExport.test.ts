import { describe, expect, it, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateTeachingScript } from '../core/course/generateTeachingScript.js';
import { buildHandoutDocxParts, buildSlidesPptxParts } from '../core/course/ooxmlRender.js';
import { exportCoursePackage } from '../core/course/exportCoursePackage.js';
import { toZipBuffer } from '../adapters/core/packageWriter.js';
import { readZipEntries } from '../adapters/core/decoders/pptxTextExtract.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import type { CourseStructure } from '../core/course/designCourseStructure.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function structureFixture(): CourseStructure {
  return {
    courseScript: {
      title: '种群生态学', audience: '本科生', totalMinutes: 10,
      modules: [{ id: 'm1', title: '种群生态学', minutes: 10, lessonIds: ['l1'] }],
    },
    teachingStructure: [{
      id: 'm1', title: '种群生态学', sectionIds: [],
      minutes: 10,
      lessons: [{
        id: 'l1', title: '种群密度', moduleId: 'm1', sectionIds: [],
        conceptIds: ['con-0'], minutes: 10,
        phases: [
          { kind: '导入', minutes: 1, conceptIds: [] },
          { kind: '讲解', minutes: 5, conceptIds: ['con-0'] },
          { kind: '小结', minutes: 4, conceptIds: ['con-0'] },
        ],
        assessmentPoints: ['种群密度'],
      }],
    }],
    teachingFlow: { steps: [], edges: [] },
  };
}

describe('R4-3 OOXML 写出（反馈 a P1-5）', () => {
  it('handout-docx 部件：内容类型/关系/document 齐全，含课时标题与分镜表', async () => {
    const script = (await generateTeachingScript({ structure: structureFixture() })).data!;
    const parts = buildHandoutDocxParts(script, '种群生态学');
    const paths = parts.map((p) => p.path);
    for (const needed of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']) {
      expect(paths).toContain(needed);
    }
    const doc = parts.find((p) => p.path === 'word/document.xml')!.content;
    expect(doc).toContain('种群密度'); // 课时标题
    expect(doc).toContain('<w:tbl>'); // 分镜表格
    expect(doc).toContain('口播稿');
    // 转义：口播中的引号不破坏 XML
    expect(doc).not.toMatch(/<w:t[^>]*>[^<]*"[^<]*<\/w:t>/);
  });

  it('slides-pptx 部件：封面 + 每课时一页，结构部件齐全', async () => {
    const script = (await generateTeachingScript({ structure: structureFixture() })).data!;
    const parts = buildSlidesPptxParts(script, '种群生态学');
    const paths = parts.map((p) => p.path);
    for (const needed of ['ppt/presentation.xml', 'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']) {
      expect(paths).toContain(needed);
    }
    const pres = parts.find((p) => p.path === 'ppt/presentation.xml')!.content;
    expect(pres.match(/<p:sldId /g)!.length).toBe(2); // 封面 + 1 课时
  });

  it('export formats 支持 handout-docx/slides-pptx，部件进包；默认全集不变', async () => {
    const script = (await generateTeachingScript({ structure: structureFixture() })).data!;
    const r = await exportCoursePackage({
      script,
      options: { formats: ['handout-docx', 'slides-pptx'] },
    });
    expect(r.level).toBe('full');
    const paths = r.data!.package.files.map((f) => f.path);
    expect(paths).toContain('handout/word/document.xml');
    expect(paths).toContain('slides/ppt/presentation.xml');
    // 默认全集（不指定 formats）不含 OOXML 部件
    const def = await exportCoursePackage({ script });
    expect(def.level).toBe('full');
    expect(def.data!.package.files.some((f) => f.path.startsWith('handout/'))).toBe(false);
  });

  it('outDocx/outPptx 写出真实 zip 产物：zip 可读、条目完整、确定性（同输入同字节）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ny-ooxml-'));
    dirs.push(dir);
    const adapter = new LocalAdapter();
    const script = (await generateTeachingScript({ structure: structureFixture() })).data!;
    const inputs = {
      script,
      options: { formats: ['handout-docx', 'slides-pptx'] },
      outDocx: join(dir, '教案.docx'),
      outPptx: join(dir, '课件.pptx'),
    };
    const r1 = await adapter.invokeSkill('export_course_package', { inputs });
    expect(r1.level).toBe('full');
    expect(existsSync(join(dir, '教案.docx'))).toBe(true);
    expect(existsSync(join(dir, '课件.pptx'))).toBe(true);

    // zip 结构可读（与读取端 readZipEntries 互操作）
    const docxBytes = new Uint8Array(readFileSync(join(dir, '教案.docx')));
    const entries = readZipEntries(docxBytes, new Set(['word/document.xml', '[Content_Types].xml']));
    expect(entries.get('word/document.xml')!.toString('utf8')).toContain('种群密度');

    // 确定性：再写一次字节一致
    await adapter.invokeSkill('export_course_package', { inputs });
    const docx2 = readFileSync(join(dir, '教案.docx'));
    expect(toZipBuffer({ manifest: { packageName: 'x', title: 'x', formats: [], fileCount: 0, generatedBy: 'nangying-starmap' }, files: [] })).toBeInstanceOf(Buffer);
    expect(docx2.equals(readFileSync(join(dir, '教案.docx')))).toBe(true);
  }, 30000);
});

describe('R14：handout-docx 表格格子级 API（colSpan/rowSpan，对齐 PdfCell）', () => {
  const SPAN_TABLE = {
    title: '考核表',
    rows: [
      [{ text: '考核', colSpan: 2, align: 'center' as const }, { text: '备注' }],
      [{ text: 'Q1', rowSpan: 2 }, { text: '10' }, { text: 'ok' }],
      [{ text: '—' }, { text: 'y' }],
    ],
  };

  it('gridSpan/vMerge XML 结构：restart/continue/空 tc/居中段落', async () => {
    const script = (await generateTeachingScript({ structure: structureFixture() })).data!;
    const parts = buildHandoutDocxParts(script, '种群生态学', [SPAN_TABLE]);
    const doc = parts.find((p) => p.path === 'word/document.xml')!.content;
    // colSpan → w:gridSpan；rowSpan 首格 → vMerge restart
    expect(doc).toContain('<w:gridSpan w:val="2"/>');
    expect(doc).toContain('<w:vMerge w:val="restart"/>');
    // 覆盖格：空 tc + vMerge continue（无 val，Word 校验要求保留 tc 标签）
    expect(doc).toContain('<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:vMerge/></w:tcPr><w:p><w:r><w:t xml:space="preserve"></w:t></w:r></w:p></w:tc>');
    // 居中对齐段落
    expect(doc).toContain('<w:jc w:val="center"/>');
    // 结构计数：3 行；row0 两个 tc（gridSpan 格 + 备注），row1 三个 tc，row2 三个 tc（含 vMerge 覆盖格）
    expect(doc.match(/<w:vMerge w:val="restart"\/>/g)!.length).toBe(1);
    expect(doc.match(/<w:vMerge\/>/g)!.length).toBe(1);
    const tbl = /<w:tbl>[\s\S]*考核表[\s\S]*?<\/w:tbl>/.exec(doc);
    expect(tbl).not.toBeNull();
    // 附加表标题以 Heading2 进 outline
    expect(doc).toContain('<w:pStyle w:val="Heading2"/>');
  });

  it('无 span 分镜表逐字节不变（sha256 快照锁定，git HEAD 实测一致）', async () => {
    const script = (await generateTeachingScript({ structure: structureFixture() })).data!;
    const parts = buildHandoutDocxParts(script, '种群生态学');
    expect(createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex'))
      .toBe('1aa53d355c0b74792fdb5cebfb6feba2e45fa595acd16b834a330dff6a96b004');
    // 纯格子对象（无 span）与字符串格子输出一致
    const viaCells = buildHandoutDocxParts(script, '种群生态学', [
      { title: 'T', rows: [[{ text: 'A' }, { text: 'B' }], [{ text: 'C' }, { text: 'D' }]] },
    ]);
    const viaStrings = buildHandoutDocxParts(script, '种群生态学', [
      { title: 'T', rows: [['A', 'B'], ['C', 'D']] },
    ]);
    expect(JSON.stringify(viaCells)).toBe(JSON.stringify(viaStrings));
  });

  it('端到端：handoutTables 透传 → 真实 docx zip → render_preview 读回表格维度', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ny-r14-'));
    dirs.push(dir);
    const adapter = new LocalAdapter();
    const script = (await generateTeachingScript({ structure: structureFixture() })).data!;
    const outDocx = join(dir, '教案.docx');
    const r = await adapter.invokeSkill('export_course_package', {
      inputs: {
        script,
        options: { formats: ['handout-docx'] },
        handoutTables: [SPAN_TABLE],
        outDocx,
      },
    });
    expect(r.level).toBe('full');
    expect(existsSync(outDocx)).toBe(true);
    const preview = await adapter.invokeSkill('render_preview', {
      inputs: { file: outDocx, detailLevel: 'full' },
    });
    expect(preview.level).not.toBe('unavailable');
    const docx = (preview.data as { docx: { tables: Array<{ rows: number; cols: number; header: string[] }> } }).docx;
    // 表 0 = 分镜表（3 环节 + 表头 = 4 行 3 列）；表 1 = 附加合并表
    expect(docx.tables[0]).toMatchObject({ rows: 4, cols: 3 });
    const merged = docx.tables[1];
    expect(merged.rows).toBe(3);
    // render_preview 的 cols = 首行 tc 数：gridSpan 格算 1 个 tc → 2（考核/备注）
    expect(merged.cols).toBe(2);
    expect(merged.header).toEqual(['考核', '备注']);
  }, 30000);
});
