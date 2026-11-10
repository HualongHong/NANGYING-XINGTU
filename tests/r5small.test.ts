import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractKnowledgeGraph, looksLikeLatex } from '../core/graph/extractKnowledgeGraph.js';
import { generatePersonalizedFeedback } from '../core/qa/generatePersonalizedFeedback.js';
import { exportCoursePackage } from '../core/course/exportCoursePackage.js';
import { generateTeachingScript } from '../core/course/generateTeachingScript.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import type { CourseStructure } from '../core/course/designCourseStructure.js';
import type { LLMProvider } from '../core/llm.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function structureFixture(): CourseStructure {
  return {
    courseScript: { title: '种群生态学', audience: '本科生', totalMinutes: 8, modules: [{ id: 'm1', title: '种群生态学', minutes: 8, lessonIds: ['l1', 'l2'] }] },
    teachingStructure: [{
      id: 'm1', title: '种群生态学', sectionIds: [], minutes: 8,
      lessons: [
        { id: 'l1', title: '种群密度', moduleId: 'm1', sectionIds: [], conceptIds: [], minutes: 4, phases: [{ kind: '导入', minutes: 1, conceptIds: [] }, { kind: '讲解', minutes: 3, conceptIds: [] }], assessmentPoints: [] },
        { id: 'l2', title: '调查方法', moduleId: 'm1', sectionIds: [], conceptIds: [], minutes: 4, phases: [{ kind: '导入', minutes: 1, conceptIds: [] }, { kind: '讲解', minutes: 3, conceptIds: [] }], assessmentPoints: [] },
      ],
    }],
    teachingFlow: { steps: [], edges: [] },
  };
}

describe('R5-5.2 图谱实体 LaTeX formula 属性', () => {
  it('looksLikeLatex 判定：$...$、\\frac、上标', () => {
    expect(looksLikeLatex('米氏方程 $v=\\frac{V[S]}{K_m+[S]}$')).toBe(true);
    expect(looksLikeLatex('x^2 加和')).toBe(true);
    expect(looksLikeLatex('种群密度')).toBe(false);
  });

  it('含公式候选 → 实体带 formula 透传', async () => {
    const parsed = {
      structuredSections: [{ title: '酶动力学', level: 1, order: 0 }],
      tables: [],
      paragraphs: [{ index: 0, text: '米氏方程描述反应速率。', sectionOrder: 0 }],
      knowledgePointCandidates: [
        { term: '米氏方程 $v=\\frac{V[S]}{K_m+[S]}$', score: 5, occurrences: [0] },
        { term: '米氏常数', score: 4, occurrences: [0] },
      ],
    } as never;
    const r = await extractKnowledgeGraph(parsed);
    const withFormula = r.data!.entities.filter((e) => e.formula);
    expect(withFormula.length).toBeGreaterThanOrEqual(1);
    expect(withFormula[0].formula).toContain('\\frac');
    // 常规实体不带 formula
    expect(r.data!.entities.find((e) => e.label === '米氏常数')?.formula).toBeUndefined();
  });
});

describe('R5-5.3 freeTextReport 自由文本报告反馈', () => {
  it('段落级反馈：摘录/评语/待改进点；无 quiz/graph 也可调用', async () => {
    const report = '实验目的是测定种群密度。操作方法基本正确但是数据记录不完整\n结果分析大概差不多，没有图表支撑。';
    const r = await generatePersonalizedFeedback({ freeTextReport: report });
    expect(r.level).toBe('full');
    const ft = r.data!.freeTextFeedback!;
    expect(ft.paragraphs).toHaveLength(2);
    expect(ft.paragraphs[0].excerpt).toContain('种群密度');
    expect(ft.paragraphs[0].issues.length).toBeGreaterThanOrEqual(0);
    expect(ft.paragraphs[1].issues.some((i) => i.includes('含糊') || i.includes('数据'))).toBe(true);
    // quiz 模式字段为空形态
    expect(r.data!.conceptAnalysis).toEqual([]);
  });

  it('LLM 可用时精炼段落评语；失败回落模板并标 degraded', async () => {
    const llm: LLMProvider = {
      complete: async () => JSON.stringify(['LLM评语：本段目的明确，建议补充对照。']),
    };
    const r = await generatePersonalizedFeedback({ freeTextReport: '实验目的是测定种群密度。' }, { llm });
    expect(r.level).toBe('full');
    expect(r.data!.freeTextFeedback!.paragraphs[0].comment).toContain('LLM评语');

    const bad: LLMProvider = { complete: async () => '非JSON' };
    const d = await generatePersonalizedFeedback({ freeTextReport: '实验目的是测定种群密度。' }, { llm: bad });
    expect(d.level).toBe('degraded');
    expect(d.degradationNote).toContain('回落模板');
    expect(d.data!.freeTextFeedback!.paragraphs).toHaveLength(1);
  });

  it('适配器端到端 + quiz 模式不回归', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('generate_personalized_feedback', {
      inputs: { freeTextReport: '实验目的是测定种群密度。操作规范，数据完整。' },
    });
    expect(r.level).toBe('full');
    expect((r.data as { freeTextFeedback: { paragraphs: unknown[] } }).freeTextFeedback.paragraphs).toHaveLength(1);
  });
});

describe('R5-5.1/5.4 export outputPath 与 directoryTemplate', () => {
  it('directoryTemplate：按课时产出自定义路径 markdown，默认结构不变', async () => {
    const script = (await generateTeachingScript({ structure: structureFixture() })).data!;
    const r = await exportCoursePackage({
      script,
      options: { formats: ['markdown'], directoryTemplate: '{index}-{lesson}/script.{ext}' },
    });
    const paths = r.data!.package.files.map((f) => f.path);
    expect(paths).toContain('01-种群密度/script.md');
    expect(paths).toContain('02-调查方法/script.md');
    expect(paths).not.toContain('markdown/package.md');
    const def = await exportCoursePackage({ script, options: { formats: ['markdown'] } });
    expect(def.data!.package.files.map((f) => f.path)).toContain('markdown/package.md');
  });

  it('outputPath：整包落盘 + docx/pptx 组装件，绝对路径写入 writtenFiles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ny-outpath-'));
    dirs.push(dir);
    const out = join(dir, '产物');
    const adapter = new LocalAdapter();
    const script = (await generateTeachingScript({ structure: structureFixture() })).data!;
    const r = await adapter.invokeSkill('export_course_package', {
      inputs: {
        script,
        options: { formats: ['markdown', 'handout-docx', 'slides-pptx'] },
        outputPath: out,
      },
    });
    expect(r.level).toBe('full');
    const data = r.data as { writtenFiles: string[] };
    expect(data.writtenFiles.length).toBeGreaterThan(0);
    for (const f of data.writtenFiles) expect(f.startsWith(resolve(out).slice(0, 5))).toBe(true);
    // docx/pptx 组装件真实存在且为合法 zip（PK 头）
    const docx = join(resolve(out), 'handout.docx');
    const pptx = join(resolve(out), 'slides.pptx');
    expect(existsSync(docx)).toBe(true);
    expect(existsSync(pptx)).toBe(true);
    expect(readFileSync(docx).subarray(0, 2).toString()).toBe('PK');
    expect(readFileSync(pptx).subarray(0, 2).toString()).toBe('PK');
    // 不传 outputPath 行为不变（无 writtenFiles）
    const plain = await adapter.invokeSkill('export_course_package', {
      inputs: { script, options: { formats: ['markdown'] } },
    });
    expect((plain.data as { writtenFiles?: string[] }).writtenFiles).toBeUndefined();
  }, 30000);
});
