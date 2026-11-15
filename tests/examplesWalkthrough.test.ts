import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

/**
 * 端到端演练守卫：examples/ 原创示例（CC0）× 配方 5 五技能全链。
 * 保证仓库自带的示例材料持续可跑通——示例即活文档，改坏任一环此测试即红。
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const abstractContent = readFileSync(`${ROOT}examples/摘要集-青年生态学论坛.txt`, 'utf8');
const chapter = JSON.parse(readFileSync(`${ROOT}examples/章节知识点-生态系统生态学.json`, 'utf8')) as {
  sections: { title: string; knowledgePoints: string[]; keyPoints?: string[]; confusables?: string[] }[];
};

const adapter = new LocalAdapter();

describe('examples/ × 配方 5 五技能端到端演练', () => {
  it('① 需求治理：Q1–Q8 逐项问齐后 stopWork=false', async () => {
    const r = await adapter.invokeSkill('gather_teaching_requirements', {
      inputs: {
        answers: {
          courseMeta: '生态学基础（示例课程），本科',
          knowledgeStructure: chapter,
          abstractCollection: '青年生态学论坛 2026 摘要集，封面自述收录 7 篇',
          template: '默认模板（须复述确认）',
          teachingParams: '2 学时，约 90 分钟',
          depthAndPlan: '按教材章节顺序讲授，配研究例证',
          casePreferences: '每节至少 1 篇研究例证',
          extraOutputs: '四件套（课件/阅读材料/自测 HTML/教案）',
        },
      },
    });
    expect(r.level).not.toBe('unavailable');
    const data = r.data as { stopWork: boolean; checklist: { status: string }[]; blockingMissing: string[] };
    expect(data.stopWork).toBe(false);
    expect(data.blockingMissing).toEqual([]);
    expect(data.checklist).toHaveLength(8);
  });

  it('② 摘要集解析：7/7 记录、Δ 偏移探测、零缺陷', async () => {
    const r = await adapter.invokeSkill('parse_abstract_collection', {
      inputs: { content: abstractContent, entryPattern: '^\\d{4}\\s', declaredTotal: 7 },
    });
    expect(r.level).not.toBe('unavailable');
    const data = r.data as {
      records: { id: string; title: string; session?: string; printedPage?: number; defects: string[] }[];
      pageOffset: { kind: string; delta?: number };
      coverage?: { parsed: number; declared?: number };
    };
    expect(data.records).toHaveLength(7);
    expect(data.pageOffset.kind).toBe('constant');
    expect(data.pageOffset.delta).toBe(1);
    expect(data.records.every((rec) => rec.defects.length === 0)).toBe(true);
    expect(data.records[0].session).toContain('分会场一');
    expect(data.coverage?.parsed).toBe(7);
  });

  it('③ 研究例证选文：每节有落位 + 收敛四条件', async () => {
    const parse = await adapter.invokeSkill('parse_abstract_collection', {
      inputs: { content: abstractContent, entryPattern: '^\\d{4}\\s', declaredTotal: 7 },
    });
    const records = (parse.data as { records: unknown[] }).records;
    const r = await adapter.invokeSkill('select_research_evidence', {
      inputs: { records, sections: chapter.sections, percentile: 0.2, perSectionMin: 1 },
    });
    expect(r.level).not.toBe('unavailable');
    const data = r.data as {
      selected: { recordId: string; section: string; mustReview: boolean }[];
      convergence: { met: boolean };
      reviewQueue: unknown[];
    };
    const sections = new Set(data.selected.map((s) => s.section));
    for (const s of chapter.sections) expect(sections.has(s.title)).toBe(true);
    expect(data.convergence.met).toBe(true);
    expect(data.reviewQueue.length).toBeGreaterThan(0);
  });

  it('④ 四件套组装：编号按节序 + 来源字段口径', async () => {
    const parse = await adapter.invokeSkill('parse_abstract_collection', {
      inputs: { content: abstractContent, entryPattern: '^\\d{4}\\s', declaredTotal: 7 },
    });
    const records = (parse.data as { records: unknown[] }).records;
    const sel = await adapter.invokeSkill('select_research_evidence', {
      inputs: { records, sections: chapter.sections, percentile: 0.2, perSectionMin: 1 },
    });
    const selected = (sel.data as { selected: unknown[] }).selected;
    const r = await adapter.invokeSkill('compose_teaching_artifacts', {
      inputs: { selected, records, courseStructure: chapter, venue: '青年生态学论坛', year: '2026' },
    });
    expect(r.level).not.toBe('unavailable');
    const data = r.data as {
      numberingMap: { caseNo: string; section: string; recordId: string }[];
      sourceFields: Record<string, string>;
      violations: unknown[];
    };
    expect(data.numberingMap.length).toBeGreaterThanOrEqual(chapter.sections.length);
    expect(data.numberingMap.map((n) => n.caseNo)).toEqual(
      data.numberingMap.map((_, i) => String(i + 1).padStart(2, '0')),
    );
    for (const [caseNo, field] of Object.entries(data.sourceFields)) {
      expect(field).toContain(`[阅读编号 ${caseNo}]`);
      expect(field).toMatch(/未提供|10\.\d{4,9}\//);
    }
    expect(data.violations).toEqual([]);
  });

  it('⑤ 教学包验收：确定性判项全 pass、零红线', async () => {
    const parse = await adapter.invokeSkill('parse_abstract_collection', {
      inputs: { content: abstractContent, entryPattern: '^\\d{4}\\s', declaredTotal: 7 },
    });
    const records = (parse.data as { records: unknown[] }).records;
    const sel = await adapter.invokeSkill('select_research_evidence', {
      inputs: { records, sections: chapter.sections, percentile: 0.2, perSectionMin: 1 },
    });
    const selected = (sel.data as { selected: unknown[] }).selected;
    const comp = await adapter.invokeSkill('compose_teaching_artifacts', {
      inputs: { selected, records, courseStructure: chapter, venue: '青年生态学论坛', year: '2026' },
    });
    const composed = comp.data as {
      numberingMap: { caseNo: string; section: string }[];
      sourceFields: Record<string, string>;
    };
    const caseNos = composed.numberingMap.map((n) => n.caseNo);

    // 按 compose 的确定性产物（编号+来源字段）合成各产物最小文本，供 audit 判定
    const slides = composed.numberingMap
      .map((n) => `研究例证帧：${composed.sourceFields[n.caseNo]}`)
      .join('\n');
    const readingPages = composed.numberingMap.flatMap((n) => [
      `原文节选：${composed.sourceFields[n.caseNo]}`,
      `解读：围绕 ${n.section} 解读该研究的结论、条件与可迁移点。`,
    ]);
    const html =
      '案例速查卡\n' +
      composed.numberingMap.map((n) => `<div class="case">${composed.sourceFields[n.caseNo]}</div>`).join('\n') +
      '\n<button>展开答案</button>';

    const r = await adapter.invokeSkill('audit_teaching_package', {
      inputs: { artifacts: { slides, reading: { pages: readingPages }, html }, expectedNumbering: caseNos },
    });
    expect(r.level).not.toBe('unavailable');
    const data = r.data as {
      report: { id: string; verdict: string }[];
      redlineTriggers: unknown[];
      passed: boolean;
    };
    const decided = data.report.filter((row) => row.verdict !== 'delegated');
    expect(decided.length).toBeGreaterThan(0);
    expect(decided.every((row) => row.verdict === 'pass')).toBe(true);
    expect(data.redlineTriggers).toEqual([]);
    expect(data.passed).toBe(true);
  });
});

describe('examples/ × 配方 1 前半链端到端演练（讲义 → 图谱 → 结构 → 讲稿）', () => {
  const lectureFile = `${ROOT}examples/讲义-光合作用基础.md`;

  it('① 课件解析：章节层级 + 候选池非空', async () => {
    const r = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: lectureFile },
    });
    expect(r.level).toBe('full');
    const data = r.data as {
      structuredSections: { title: string; level: number }[];
      paragraphs: unknown[];
      knowledgePointCandidates: { term: string }[];
    };
    expect(data.paragraphs.length).toBeGreaterThan(0);
    expect(data.knowledgePointCandidates.length).toBeGreaterThan(0);
    const titles = data.structuredSections.map((s) => s.title);
    expect(titles.some((t) => t.includes('光反应'))).toBe(true);
    expect(titles.some((t) => t.includes('碳反应'))).toBe(true);
  });

  it('② 知识图谱：概念实体覆盖讲义核心概念', async () => {
    const parsed = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: lectureFile },
    });
    const r = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { structuredContent: parsed.data },
    });
    expect(r.level).toBe('full');
    const data = r.data as { entities: { id: string; label: string }[] };
    expect(data.entities.length).toBeGreaterThan(0);
    const labels = data.entities.map((e) => e.label);
    expect(labels).toContain('光合作用');
    // 启发式 NER（无 LLM）词粒度：核心概念 + 讲义标志性术语至少命中一类
    expect(labels.some((l) => ['ATP', 'NADPH', '二氧化碳', '光能', '化学能'].includes(l))).toBe(true);
  });

  it('③ 课程结构：模块/课时/环节三级结构可生成', async () => {
    const parsed = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: lectureFile },
    });
    const extracted = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { structuredContent: parsed.data },
    });
    const r = await adapter.invokeSkill('design_course_structure', {
      inputs: { graph: extracted.data, objectives: { audience: '本科生', totalMinutes: 90 } },
    });
    expect(r.level).toBe('full');
    const data = r.data as {
      teachingStructure: { title: string; lessons: { id: string; minutes?: number }[] }[];
    };
    expect(data.teachingStructure.length).toBeGreaterThan(0);
    expect(data.teachingStructure[0].lessons.length).toBeGreaterThan(0);
  });

  it('④ 讲稿生成：分镜场景口播字幕齐备', async () => {
    const parsed = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: lectureFile },
    });
    const extracted = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { structuredContent: parsed.data },
    });
    const designed = await adapter.invokeSkill('design_course_structure', {
      inputs: { graph: extracted.data, objectives: { audience: '本科生', totalMinutes: 90 } },
    });
    const r = await adapter.invokeSkill('generate_teaching_script', {
      inputs: { structure: designed.data },
    });
    expect(r.level).toBe('full');
    const data = r.data as {
      storyboardScript: { scenes: { voiceover: string; subtitle: string; minutes: number }[] }[];
    };
    expect(data.storyboardScript.length).toBeGreaterThan(0);
    const scenes = data.storyboardScript[0].scenes;
    expect(scenes.length).toBeGreaterThan(0);
    for (const scene of scenes) {
      expect(scene.voiceover.length).toBeGreaterThan(0);
      expect(scene.subtitle).toBe(scene.voiceover);
      expect(scene.minutes).toBeGreaterThan(0);
    }
  });
});

describe('examples/ × 配方 2 链端到端演练（讲义 → 答疑库 → 学习路径）', () => {
  const lectureFile = `${ROOT}examples/讲义-光合作用基础.md`;

  async function graphFromLecture() {
    const parsed = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: lectureFile },
    });
    const extracted = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { structuredContent: parsed.data },
    });
    return { parsed, graph: extracted };
  }

  it('① 答疑库：定义/关系/流程意图问答对生成', async () => {
    const { parsed, graph } = await graphFromLecture();
    const r = await adapter.invokeSkill('build_qa_knowledge_base', {
      inputs: {
        graph: graph.data,
        paragraphs: (parsed.data as { paragraphs: unknown[] }).paragraphs,
      },
    });
    expect(r.level).toBe('full');
    const data = r.data as {
      qaPairs: { intent: string; question: string; answer: string; conceptIds: string[] }[];
    };
    expect(data.qaPairs.length).toBeGreaterThan(0);
    const intents = new Set(data.qaPairs.map((q) => q.intent));
    expect(intents.has('concept_definition')).toBe(true);
    for (const qa of data.qaPairs) {
      expect(qa.question.length).toBeGreaterThan(0);
      expect(qa.answer.length).toBeGreaterThan(0);
    }
    // 光合作用定义问答必须存在且答案不空（示例讲义核心概念）
    const photoDef = data.qaPairs.find(
      (q) => q.intent === 'concept_definition' && q.question.includes('光合作用'),
    );
    expect(photoDef).toBeTruthy();
  });

  it('② 学习路径：以核心概念为目标生成先修序序列', async () => {
    const { graph } = await graphFromLecture();
    const graphData = graph.data as { entities: { id: string; label: string }[] };
    const goal = graphData.entities.find((e) => e.label === '光合作用');
    expect(goal).toBeTruthy();
    const r = await adapter.invokeSkill('recommend_learning_path', {
      inputs: { graph: graph.data, profile: { goalConceptIds: [goal!.id], availableMinutes: 60 } },
    });
    expect(r.level).toBe('full');
    const data = r.data as {
      learningSequence: string[];
      coverage?: { goal?: string[]; missing?: string[] };
      steps?: { reason?: string }[];
    };
    expect(data.learningSequence.length).toBeGreaterThan(0);
    expect(data.learningSequence).toContain(goal!.id);
  });
});


