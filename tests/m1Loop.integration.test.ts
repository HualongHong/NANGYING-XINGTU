/**
 * M1 端到端集成测试：自拟讲稿黄金样本一路跑通
 * parse → extract → design → script，断言链路不变量（非全文快照）。
 *
 * 黄金图谱更新：GOLDEN_UPDATE=1 pnpm vitest run tests/m1Loop.integration.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCourseMaterial } from '../core/nlp/parseCourseMaterial.js';
import { extractKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import { designCourseStructure } from '../core/course/designCourseStructure.js';
import { generateTeachingScript } from '../core/course/generateTeachingScript.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import type { CourseStructure } from '../core/course/designCourseStructure.js';
import type { TeachingScript } from '../core/course/generateTeachingScript.js';

const FIXTURE = 'tests/fixtures/sample-lecture-ml-basics.md';
const GOLDEN = 'tests/fixtures/golden/sample-lecture-ml-basics.graph.json';

async function runChain() {
  const content = readFileSync(FIXTURE, 'utf8');
  const parsed = await parseCourseMaterial({ content, materialType: 'md' });
  const graph = await extractKnowledgeGraph(parsed.data!);
  const design = await designCourseStructure({
    graph: graph.data!,
    objectives: { audience: '本科生', totalMinutes: 90 },
  });
  const script = await generateTeachingScript({ structure: design.data! });
  return { parsed, graph, design, script };
}

describe('M1 端到端：黄金讲稿全链路', () => {
  it('四阶段全部 level=full 且产物非空', async () => {
    const { parsed, graph, design, script } = await runChain();
    for (const r of [parsed, graph, design, script]) expect(r.level).toBe('full');
    expect(parsed.data!.structuredSections.length).toBeGreaterThanOrEqual(13);
    expect(parsed.data!.paragraphs.length).toBeGreaterThanOrEqual(15);
    expect(parsed.data!.knowledgePointCandidates.length).toBeGreaterThanOrEqual(10);
    expect(graph.data!.entities.length).toBeGreaterThanOrEqual(10);
    expect(graph.data!.relations.length).toBeGreaterThan(0);
    expect(design.data!.teachingStructure.length).toBe(4); // 根模块 + 三章
    expect(script.data!.storyboardScript.length).toBeGreaterThan(0);
  });

  it('星图包含核心概念且章节层级正确', async () => {
    const { parsed, graph } = await runChain();
    // 图谱实体有数量上限，核心术语同时从解析层候选（全量 top-N）断言
    const candidateTerms = parsed.data!.knowledgePointCandidates.map((c) => c.term);
    expect(candidateTerms).toContain('梯度下降');
    expect(candidateTerms).toContain('损失函数');
    const labels = graph.data!.entities.map((e) => e.label);
    // MRS 语义：监督学习因 distinct≥10 经高频头词救援保留；无监督学习被
    // 更长的高频组合吸收（设计预期，见 DEV_LOG 取舍说明）
    expect(labels).toContain('监督学习');
    expect(labels).toContain('机器学习');
    const roots = graph.data!.hierarchy;
    expect(roots).toHaveLength(4); // 文档标题 + 三章（均为一级标题，构成层级森林）
    expect(roots[0].children.map((c) => c.title)).toEqual(['课程导入', '学习目标']);
    expect(roots[1].children.map((c) => c.title)).toEqual([
      '1.1 什么是机器学习',
      '1.2 监督学习与无监督学习',
    ]);
    // contains 边数 = 层级树父子对数
    const contains = graph.data!.relations.filter((r) => r.type === 'contains');
    const countPairs = (list: typeof roots): number =>
      list.reduce((n, h) => n + h.children.length + countPairs(h.children), 0);
    expect(contains).toHaveLength(countPairs(roots));
  });

  it('课时顺序满足先修拓扑序（先修在前）', async () => {
    const { graph, design } = await runChain();
    const order = new Map<string, number>();
    design.data!.teachingStructure
      .flatMap((m) => m.lessons)
      .forEach((l, i) => order.set(l.id, i));
    // 课时 → 图谱节点：经 sectionIds / conceptIds 反查所属课时
    const nodeLesson = new Map<string, number>();
    for (const l of design.data!.teachingStructure.flatMap((m) => m.lessons)) {
      for (const nid of [...l.sectionIds, ...l.conceptIds]) {
        nodeLesson.set(nid, order.get(l.id)!);
      }
    }
    for (const e of graph.data!.relations) {
      if (e.type !== 'prerequisite') continue;
      const a = nodeLesson.get(e.from);
      const b = nodeLesson.get(e.to);
      if (a === undefined || b === undefined || a === b) continue; // 同课时内的先修由环节顺序承担
      expect(a, `${e.from} 应先于 ${e.to}`).toBeLessThan(b);
    }
  });

  it('分镜脚本星图可追溯：scene 引用均指向上游真实 ID', async () => {
    const { graph, design, script } = await runChain();
    const graphNodeIds = new Set([
      ...graph.data!.entities.map((n) => n.id),
      ...graph.data!.relations.filter((r) => r.type === 'contains').map((r) => r.from),
    ]);
    const lessonIds = new Set(
      design.data!.teachingStructure.flatMap((m) => m.lessons.map((l) => l.id)),
    );
    const designConceptIds = new Set(
      design.data!.teachingStructure.flatMap((m) => m.lessons.flatMap((l) => l.conceptIds)),
    );
    let sceneCount = 0;
    for (const lesson of script.data!.storyboardScript) {
      expect(lessonIds.has(lesson.lessonId)).toBe(true);
      const phases =
        design.data!.teachingStructure
          .flatMap((m) => m.lessons)
          .find((l) => l.id === lesson.lessonId)?.phases.length ?? 0;
      expect(lesson.scenes).toHaveLength(phases); // 分镜与教学环节一一对应
      let lastStart = -1;
      for (const scene of lesson.scenes) {
        sceneCount++;
        expect(scene.lessonId).toBe(lesson.lessonId);
        expect(scene.voiceover.length).toBeGreaterThan(0);
        expect(scene.subtitle.length).toBeGreaterThan(0);
        expect(scene.startMinute).toBeGreaterThan(lastStart);
        lastStart = scene.startMinute;
        for (const cid of scene.conceptIds) {
          expect(
            designConceptIds.has(cid) || graphNodeIds.has(cid),
            `scene 引用了未知节点 ${cid}`,
          ).toBe(true);
        }
      }
    }
    expect(sceneCount).toBeGreaterThanOrEqual(13 * 3);
  });

  it('链路确定性：两次运行产物完全一致', async () => {
    const a = await runChain();
    const b = await runChain();
    expect(JSON.stringify(a.graph.data)).toBe(JSON.stringify(b.graph.data));
    expect(JSON.stringify(a.design.data)).toBe(JSON.stringify(b.design.data));
    expect(JSON.stringify(a.script.data)).toBe(JSON.stringify(b.script.data));
  });

  it('GOLDEN_UPDATE=1 时刷新黄金图谱', async () => {
    if (process.env.GOLDEN_UPDATE !== '1') return;
    const { graph } = await runChain();
    writeFileSync(GOLDEN, JSON.stringify(graph.data, null, 2));
    expect(readFileSync(GOLDEN, 'utf8')).toBe(JSON.stringify(graph.data, null, 2));
  });
});

// 类型引用防 unused（同时锁定三阶段输出类型导出稳定）
export type { CourseKnowledgeGraph, CourseStructure, TeachingScript };
