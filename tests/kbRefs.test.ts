import { describe, expect, it } from 'vitest';
import { parseCourseMaterial } from '../core/nlp/parseCourseMaterial.js';
import { extractKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import { buildTeachingKnowledgeBase } from '../core/kb/buildTeachingKnowledgeBase.js';
import { kbRetrieve } from '../core/kb/kbRetrieve.js';
import { designCourseStructure } from '../core/course/designCourseStructure.js';
import { generateTeachingScript } from '../core/course/generateTeachingScript.js';
import { generateAssessment } from '../core/qa/generateAssessment.js';
import { buildQaKnowledgeBase } from '../core/qa/buildQaKnowledgeBase.js';
import { realtimeQaStream } from '../core/specialized/realtimeQaStream.js';
import { exportCoursePackage } from '../core/course/exportCoursePackage.js';
import type { EvidencePack, TeachingKnowledgeBase } from '../core/kb/kbTypes.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';

const LECTURE = `# 光合作用

光合作用分为光反应和碳反应两个阶段。

光反应在类囊体膜上进行，产生 ATP 和 NADPH。

碳反应即卡尔文循环，在基质中固定二氧化碳合成有机物。

## 光反应

光反应需要光照条件，水是电子供体。

## 碳反应

碳反应不直接需要光，但依赖光反应产物。`;

async function fixture() {
  const parsed = await parseCourseMaterial({ content: LECTURE, materialType: 'md' });
  const graphRes = await extractKnowledgeGraph(parsed.data!);
  const graph = graphRes.data!;
  const built = buildTeachingKnowledgeBase({
    materials: [{ materialId: 'm1', parse: parsed.data! }],
    graph,
    options: { builtAt: '2026-11-27T00:00:00.000Z' },
  });
  const kb = built.data!;
  const pack = kbRetrieve(kb, '光反应 类囊体 ATP', { topK: 5 });
  return { parsed: parsed.data!, graph, kb, pack };
}

describe('R25-B 六环节 kbRefs 集成（真实链路 parse→extract→build→query）', () => {
  it('教案 design_course_structure：课时挂接 evidenceRefs；无 kbRefs 行为不变', async () => {
    const { graph, pack } = await fixture();
    const withRefs = await designCourseStructure({ graph, objectives: { audience: '本科一年级' }, kbRefs: pack });
    const lessons = withRefs.data!.teachingStructure.flatMap((m) => m.lessons);
    expect(lessons.length).toBeGreaterThan(0);
    const withEvidence = lessons.filter((l) => (l.evidenceRefs ?? []).length > 0);
    expect(withEvidence.length).toBeGreaterThan(0);
    for (const l of withEvidence) {
      for (const ref of l.evidenceRefs!) expect(ref).toMatch(/^ev-m1-p\d+$/);
    }
    const without = await designCourseStructure({ graph, objectives: { audience: '本科一年级' } });
    expect(without.data!.teachingStructure.flatMap((m) => m.lessons).every((l) => l.evidenceRefs === undefined)).toBe(true);
  });

  it('讲稿 generate_teaching_script：证据段并入取材池 + kbRefs 回声', async () => {
    const { graph, pack } = await fixture();
    const structure = (await designCourseStructure({ graph, objectives: { audience: '本科一年级' } })).data!;
    const withRefs = await generateTeachingScript({ structure, kbRefs: pack });
    const echo = (withRefs.data as { kbRefs?: { evidenceIds: string[]; sentencesAdded: number } }).kbRefs!;
    expect(echo).toBeTruthy();
    expect(echo.evidenceIds.length).toBe(pack.items.length);
    expect(echo.sentencesAdded).toBeGreaterThan(0);
    const without = await generateTeachingScript({ structure });
    expect((without.data as { kbRefs?: unknown }).kbRefs).toBeUndefined();
  });

  it('测试/出卷 generate_assessment：题目按概念挂 evidenceIds', async () => {
    const { graph, pack } = await fixture();
    const r = await generateAssessment({ graph, count: 5, kbRefs: pack });
    const items = r.data!.assessment;
    expect(items.length).toBeGreaterThan(0);
    const withEvidence = items.filter((i) => (i.evidenceIds ?? []).length > 0);
    expect(withEvidence.length).toBeGreaterThan(0);
    const without = await generateAssessment({ graph, count: 5 });
    expect(without.data!.assessment.every((i) => i.evidenceIds === undefined)).toBe(true);
  });

  it('辅导 realtime_qa_stream：答案附证据出处（top2，含 citation/origin）', async () => {
    const { parsed, graph, pack } = await fixture();
    const qa = await buildQaKnowledgeBase({ graph, paragraphs: parsed.paragraphs });
    const r = await realtimeQaStream({ question: '光反应在哪里进行？', qaKnowledgeBase: qa.data!, kbRefs: pack });
    const evidence = (r.data as { evidence?: Array<{ evidenceId: string; origin: string }> }).evidence!;
    expect(evidence).toBeTruthy();
    expect(evidence.length).toBeLessThanOrEqual(2);
    expect(evidence[0].evidenceId).toMatch(/^ev-m1-p\d+$/);
    expect(evidence[0].origin).toBe('corpus');
    const without = await realtimeQaStream({ question: '光反应在哪里进行？', qaKnowledgeBase: qa.data! });
    expect((without.data as { evidence?: unknown }).evidence).toBeUndefined();
  });

  it('课件 export_course_package：knowledgeBase 导出 kb/kb.json', async () => {
    const { graph, kb } = await fixture();
    const structure = (await designCourseStructure({ graph, objectives: { audience: '本科一年级' } })).data!;
    const script = (await generateTeachingScript({ structure })).data!;
    const r = await exportCoursePackage({ script, knowledgeBase: kb as TeachingKnowledgeBase, options: { formats: ['markdown'] } });
    const files = (r.data as { package: { files: Array<{ path: string }> } }).package.files;
    expect(files.some((f) => f.path === 'kb/kb.json')).toBe(true);
    const without = await exportCoursePackage({ script, options: { formats: ['markdown'] } });
    expect((without.data as { package: { files: Array<{ path: string }> } }).package.files.some((f) => f.path === 'kb/kb.json')).toBe(false);
  });

  it('证据包概念与图谱概念对齐（挂接非空的前提校验）', async () => {
    const { graph, pack } = await fixture();
    const graphConceptIds = new Set(graph.entities.filter((e: CourseKnowledgeGraph['entities'][number]) => e.kind === 'concept').map((e: CourseKnowledgeGraph['entities'][number]) => e.id));
    expect(pack.concepts.length).toBeGreaterThan(0);
    for (const c of pack.concepts) expect(graphConceptIds.has(c.id)).toBe(true);
    expect(pack.items.length).toBeGreaterThan(0);
    void (0 as unknown as EvidencePack);
  });
});
