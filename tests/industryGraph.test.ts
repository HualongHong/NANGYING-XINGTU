import { describe, expect, it } from 'vitest';
import { buildIndustryGraph, lexicalIndustryExtract } from '../core/graph/buildIndustryGraph.js';
import { linkKnowledgeIndustry, lexicalTermScore } from '../core/graph/linkKnowledgeIndustry.js';
import { recommendLearningPath } from '../core/graph/recommendLearningPath.js';
import { fuseKnowledgeGraphs } from '../core/graph/fuseKnowledgeGraphs.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import type { LLMProvider } from '../core/llm.js';

/** 合成课程图谱（三个概念 + 先修链 c1→c2→c3） */
function courseGraph(): CourseKnowledgeGraph {
  return {
    schemaVersion: '1.2',
    entities: [
      { id: 'con-1', kind: 'concept', label: '酶动力学参数测定', level: 0, order: 0, source: { sectionOrder: [0], paragraphIndexes: [0] } },
      { id: 'con-2', kind: 'concept', label: '分光光度法', level: 0, order: 1, source: { sectionOrder: [0], paragraphIndexes: [1] } },
      { id: 'con-3', kind: 'concept', label: '种群密度', level: 0, order: 2 },
    ],
    relations: [
      { id: 'e1', from: 'con-1', to: 'con-2', type: 'prerequisite', weight: 1 },
      { id: 'e2', from: 'con-2', to: 'con-3', type: 'prerequisite', weight: 1 },
    ],
    hierarchy: [],
    prerequisiteGraph: { nodes: ['con-1', 'con-2', 'con-3'], edges: [], topoOrder: ['con-1', 'con-2', 'con-3'] },
  };
}

const INDUSTRY_SECTIONS = [{
  id: 'bio-med',
  title: '生物医药检测',
  fields: {
    岗位: ['体外诊断试剂研发工程师', '质量控制专员'],
    工作任务: ['试剂配方开发与验证', '分析方法学转移'],
    技能要求: ['酶动力学参数测定', '分光光度法', 'GLP 规范'],
    工具: ['酶标仪', '紫外分光光度计'],
    趋势: ['体外诊断行业扩容', '监管趋严'],
  },
}];

describe('R9-1 #28 build_industry_graph', () => {
  it('sections+fields：六类本体 + 五类关系 + stats.byType + 确定性 ID', async () => {
    const r = await buildIndustryGraph({ sections: INDUSTRY_SECTIONS });
    expect(r.level).toBe('full');
    const g = r.data!;
    expect(g.schemaVersion).toBe('1.2');
    expect(g.stats!.byType).toMatchObject({ industry: 1, occupation: 2, workTask: 2, skill: 3, tool: 2, trend: 2 });
    const types = new Set(g.relations.map((e) => e.type));
    for (const t of ['industry_has_occupation', 'occupation_has_task', 'task_requires_skill', 'skill_uses_tool', 'trend_drives_skill']) {
      expect(types.has(t)).toBe(true);
    }
    // 链接线结构：产业→岗位→任务→技能→工具；趋势→技能
    const occ = g.entities.find((n) => n.label === '体外诊断试剂研发工程师')!;
    expect(g.relations.some((e) => e.from !== occ.id && e.to === occ.id && e.type === 'industry_has_occupation')).toBe(true);
    const skill = g.entities.find((n) => n.label === '酶动力学参数测定')!;
    const task = g.entities.find((n) => n.label === '试剂配方开发与验证')!;
    expect(g.relations.some((e) => e.from === task.id && e.to === skill.id && e.type === 'task_requires_skill')).toBe(true);
    // 确定性：同输入同输出
    const r2 = await buildIndustryGraph({ sections: INDUSTRY_SECTIONS });
    expect(JSON.stringify(r2.data)).toBe(JSON.stringify(g));
  });

  it('fieldMap 自定义键名归一 + 字符串值切分', async () => {
    const r = await buildIndustryGraph({
      sections: [{ id: 'X', title: '检测服务', fields: { 职位要求: '熟悉 HPLC 操作、GLP 规范', 设备: '高效液相色谱仪' } }],
      fieldMap: { 职位要求: 'skill', 设备: 'tool' },
    });
    const labels = r.data!.entities.map((n) => n.label);
    expect(labels).toContain('HPLC 操作');
    expect(labels).toContain('GLP 规范');
    expect(labels).toContain('高效液相色谱仪');
  });

  it('text 形态：词面启发式（无 LLM degraded）+ 岗位词典/动词短语模式', async () => {
    const jd = '体外诊断试剂研发工程师：要求熟悉酶动力学参数测定、分光光度法，具备 GLP 规范意识。负责试剂配方开发与验证，参与分析方法学转移。';
    const r = await buildIndustryGraph({ text: jd });
    expect(r.level).toBe('degraded');
    expect(r.degradationNote).toContain('词面启发式');
    const labels = r.data!.entities.map((n) => n.label);
    expect(labels).toContain('体外诊断试剂研发工程师');
    expect(labels).toContain('酶动力学参数测定');
    expect(labels).toContain('试剂配方开发与验证');
    // 词面抽取器单测
    const lex = lexicalIndustryExtract('招聘质检工程师。掌握高效液相色谱法。负责产品放行检验。');
    expect(lex.some((e) => e.type === 'occupation' && e.label.includes('质检工程师'))).toBe(true);
    expect(lex.some((e) => e.type === 'skill' && e.label.includes('液相色谱'))).toBe(true);
    expect(lex.some((e) => e.type === 'workTask' && e.label.includes('产品放行检验'))).toBe(true);
  });

  it('text 形态 LLM 抽取（mock）；失败回落词面并标 degraded；双缺 unavailable', async () => {
    const jd = '体外诊断试剂研发工程师：要求熟悉酶动力学参数测定。';
    const llm: LLMProvider = {
      complete: async () => JSON.stringify([
        { type: 'occupation', label: '体外诊断试剂研发工程师' },
        { type: 'skill', label: '酶动力学参数测定' },
        { type: 'trend', label: '体外诊断行业扩容' },
      ]),
    };
    const r = await buildIndustryGraph({ text: jd }, { llm });
    expect(r.level).toBe('full');
    expect(r.data!.entities.map((n) => n.label)).toContain('体外诊断行业扩容');

    const badLlm: LLMProvider = { complete: async () => '非JSON' };
    const d = await buildIndustryGraph({ text: jd }, { llm: badLlm });
    expect(d.level).toBe('degraded');
    expect(d.degradationNote).toContain('回落');

    const none = await buildIndustryGraph({});
    expect(none.level).toBe('unavailable');
    expect(none.errorCode).toBe('INVALID_INPUT');
  });

  it('与 conceptual 图谱 fuse 互操作（冒烟）', async () => {
    const industry = (await buildIndustryGraph({ sections: INDUSTRY_SECTIONS })).data!;
    const fused = await fuseKnowledgeGraphs({ graphs: [courseGraph(), industry], sources: [{ id: '课程' }, { id: '产业' }] });
    expect(['full', 'degraded']).toContain(fused.level);
    expect(fused.data!.graph.entities.length).toBeGreaterThanOrEqual(9);
  });
});

describe('R9-2 #29 link_knowledge_industry', () => {
  it('词面层真跑：精确/包含匹配 + 类型映射 + lexical 证据', async () => {
    const industry = (await buildIndustryGraph({ sections: INDUSTRY_SECTIONS })).data!;
    const r = await linkKnowledgeIndustry({ courseGraph: courseGraph(), industryGraph: industry });
    const matched = r.data!.matched;
    // 两个课程概念与产业 skill 精确同名 → maps_to_skill
    const m1 = matched.find((l) => l.from === 'con-1')!;
    expect(m1.to).toBe(industry.entities.find((n) => n.label === '酶动力学参数测定')!.id);
    expect(m1.type).toBe('maps_to_skill');
    expect(m1.confidence).toBe(1);
    expect(m1.evidence).toContain('精确');
    expect(m1.source).toBe('lexical');
    // 种群密度无产业对应 → coverage 冗余提示
    expect(r.data!.coverage.some((c) => c.entityId === 'con-3')).toBe(true);
    // 缺口：GLP 规范 被两个岗位要求 → heat=2 排前
    const glp = r.data!.gaps.find((g) => g.label === 'GLP 规范')!;
    expect(glp.heat).toBe(2);
    expect(glp.demandedByOccupations.length).toBe(2);
    expect(glp.suggestion).toContain('建议补充教学点');
    expect(r.data!.gaps[0].heat).toBeGreaterThanOrEqual(r.data!.gaps[r.data!.gaps.length - 1].heat);
  });

  it('词面重叠打分（bigram 包含率）与阈值', () => {
    expect(lexicalTermScore('酶动力学', '酶动力学')).toBe(1);
    expect(lexicalTermScore('分光光度法', '可见分光光度法')).toBe(0.8);
    expect(lexicalTermScore('酶动力学参数测定', '酶动力学测定')).toBeGreaterThan(0.5);
    expect(lexicalTermScore('种群密度', 'GLP 规范')).toBeLessThan(0.5);
  });

  it('LLM 语义层（mock）：打分 ≥0.4 入链、maxLinksPerNode 限扇出、失败回落 degraded', async () => {
    const industry = (await buildIndustryGraph({ sections: INDUSTRY_SECTIONS })).data!;
    const occ = industry.entities.find((n) => n.nodeType === 'occupation')!;
    const llm: LLMProvider = {
      complete: async () => JSON.stringify([
        { from: 'con-3', to: occ.id, score: 0.75, reason: '生态调查能力', evidence: '种群密度是野外调查基础' },
        { from: 'con-3', to: industry.entities.find((n) => n.label === 'GLP 规范')!.id, score: 0.2, reason: '低相关', evidence: 'x' },
      ]),
    };
    const r = await linkKnowledgeIndustry({ courseGraph: courseGraph(), industryGraph: industry }, { llm });
    expect(r.level).toBe('full');
    const llmLinks = r.data!.links.filter((l) => l.source === 'llm');
    expect(llmLinks).toHaveLength(1);
    expect(llmLinks[0].type).toBe('needed_by_occupation');
    expect(llmLinks[0].confidence).toBe(0.75);
    expect(llmLinks[0].evidence).toContain('种群密度');

    const bad: LLMProvider = { complete: async () => '垃圾' };
    const d = await linkKnowledgeIndustry({ courseGraph: courseGraph(), industryGraph: industry }, { llm: bad });
    expect(d.level).toBe('degraded');
    expect(d.degradationNote).toContain('词面层');
    expect(d.data!.stats.lexical).toBeGreaterThan(0);
  });

  it('jobPostings 现场抽取补充产业侧实体（词面回落）', async () => {
    const industry = (await buildIndustryGraph({ sections: INDUSTRY_SECTIONS })).data!;
    const r = await linkKnowledgeIndustry({
      courseGraph: courseGraph(),
      industryGraph: industry,
      jobPostings: ['招聘分子诊断研发工程师：要求熟悉酶动力学参数测定与核酸提取技术。'],
    });
    // 补充实体参与关联：酶动力学参数测定 经 JD 侧 skill 再命中
    expect(r.data!.stats.lexical).toBeGreaterThanOrEqual(2);
  });

  it('experimental 图谱（nodes 形态）课程侧兼容', async () => {
    const industry = (await buildIndustryGraph({ sections: INDUSTRY_SECTIONS })).data!;
    const expGraph = {
      nodes: [
        { id: 'exp-a', type: 'experiment', label: '米氏常数的测定' },
        { id: 'std-a', type: 'standard', label: '分光光度法' },
      ],
      edges: [],
    } as never;
    const r = await linkKnowledgeIndustry({ courseGraph: expGraph, industryGraph: industry });
    // 分光光度法 精确命中产业 skill
    expect(r.data!.matched.some((l) => l.from === 'std-a' && l.confidence === 1)).toBe(true);
  });
});

describe('R9-3 recommend targetOccupation（缺口倒排；缺省行为不变）', () => {
  async function industryGraphOf() {
    return (await buildIndustryGraph({ sections: INDUSTRY_SECTIONS })).data!;
  }

  it('缺省行为逐字节不变（无 targetOccupation 时与旧路径一致）', async () => {
    const g = courseGraph();
    const a = await recommendLearningPath({ graph: g, profile: { availableMinutes: 60 } });
    const b = await recommendLearningPath({ graph: g, profile: { availableMinutes: 60 }, targetOccupation: '不存在的岗位', industryGraph: await industryGraphOf() });
    expect(a.data!.learningSequence).toEqual(['con-1', 'con-2', 'con-3']);
    // 岗位不存在 → 不倒排，序列不变
    expect(b.data!.learningSequence).toEqual(a.data!.learningSequence);
  });

  it('目标岗位缺口倒排：required skill 先修概念前移 + 缺口说明', async () => {
    const g = courseGraph();
    const industry = await industryGraphOf();
    const r = await recommendLearningPath({
      graph: g,
      profile: {},
      targetOccupation: '体外诊断试剂研发工程师',
      industryGraph: industry,
    });
    // con-1（酶动力学参数测定）与 con-2（分光光度法）是岗位要求技能 → 前移；con-3 非岗位相关 → 后移
    expect(r.data!.learningSequence[0]).toBe('con-1');
    expect(r.data!.learningSequence.indexOf('con-3')).toBe(2);
    expect(r.degradationNote).toContain('目标岗位');
    expect(r.degradationNote).toContain('缺口');
    expect(r.degradationNote).toContain('GLP 规范');
  });

  it('适配器端到端（含字段别名 industryGraph 透传）', async () => {
    const adapter = new LocalAdapter();
    const industry = await adapter.invokeSkill('build_industry_graph', { inputs: { sections: INDUSTRY_SECTIONS } });
    expect(industry.level).toBe('full');
    const r = await adapter.invokeSkill('link_knowledge_industry', {
      inputs: { courseGraph: JSON.stringify(courseGraph()), industryGraph: JSON.stringify(industry.data) },
    });
    expect(r.level).toBe('full');
    expect((r.data as { matched: unknown[] }).matched.length).toBeGreaterThanOrEqual(2);
    const path = await adapter.invokeSkill('recommend_learning_path', {
      inputs: {
        graph: JSON.stringify(courseGraph()),
        profile: {},
        targetOccupation: '质量控制专员',
        industryGraph: JSON.stringify(industry.data),
      },
    });
    expect(path.level).toBe('full');
  });
});

describe('R10-2 词面层句子级共现窗口', () => {
  const THREE_JD = [
    '体外诊断试剂研发工程师：要求熟悉酶动力学参数测定、分光光度法。',
    '质量控制专员：要求熟悉 GLP 规范、产品放行检验。',
    '质检工程师：要求熟悉高效液相色谱法。',
  ].join('\n');

  it('三岗位 JD：各岗位只连自己 JD 内出现的技能，不再全部共享', async () => {
    const r = await buildIndustryGraph({ text: THREE_JD });
    expect(r.level).toBe('degraded');
    const g = r.data!;
    const occ = (label: string) => g.entities.find((n) => n.label === label)!;
    const skillsOf = (occLabel: string) =>
      g.relations.filter((e) => e.from === occ(occLabel).id && e.type === 'task_requires_skill').map((e) => g.entities.find((n) => n.id === e.to)!.label);
    expect(skillsOf('体外诊断试剂研发工程师').sort()).toEqual(['分光光度法', '酶动力学参数测定']);
    expect(skillsOf('质量控制专员').sort()).toEqual(['GLP 规范', '产品放行检验'].sort());
    expect(skillsOf('质检工程师')).toEqual(['高效液相色谱法']);
    // 确定性：同输入同输出
    const r2 = await buildIndustryGraph({ text: THREE_JD });
    expect(JSON.stringify(r2.data)).toBe(JSON.stringify(g));
  });

  it('边权重=共现句数；相邻句窗口可配（window=1 命中，window=0 不建共现边）', async () => {
    const dup = '质检工程师：要求熟悉高效液相色谱法。质检工程师：要求熟悉高效液相色谱法。';
    const r = await buildIndustryGraph({ text: dup });
    const e = r.data!.relations.find((x) => x.type === 'task_requires_skill')!;
    expect(e.weight).toBe(2); // 两句共现 → 权重 2
    // 相邻句：岗位与技能分属两句
    const split = '质检工程师。要求熟悉高效液相色谱法。';
    const w0 = await buildIndustryGraph({ text: split, lexicalWindow: 0 });
    // window=0 无共现边 → 回退旧平铺全连接（岗位-技能仍全连，但权重恒 1）
    expect(w0.data!.relations.find((x) => x.type === 'task_requires_skill')!.weight).toBe(1);
    const w1 = await buildIndustryGraph({ text: split, lexicalWindow: 1 });
    expect(w1.data!.relations.find((x) => x.type === 'task_requires_skill')!.weight).toBe(1);
    // window 上限钳制到 3：非法值不抛错
    const w9 = await buildIndustryGraph({ text: split, lexicalWindow: 9 });
    expect(w9.data!.relations.length).toBeGreaterThan(0);
  });

  it('LLM 层不受影响：text 形态 LLM 成功仍全连接旧语义', async () => {
    const jd = '体外诊断试剂研发工程师：要求熟悉酶动力学参数测定。质量控制专员：要求熟悉 GLP 规范。';
    const llm: LLMProvider = {
      complete: async () => JSON.stringify([
        { type: 'occupation', label: '体外诊断试剂研发工程师' },
        { type: 'occupation', label: '质量控制专员' },
        { type: 'skill', label: '酶动力学参数测定' },
        { type: 'skill', label: 'GLP 规范' },
      ]),
    };
    const r = await buildIndustryGraph({ text: jd, lexicalWindow: 0 }, { llm });
    expect(r.level).toBe('full');
    const g = r.data!;
    const occs = g.entities.filter((n) => n.nodeType === 'occupation');
    // LLM 形态保持旧 buildFromEntities 全连接：两岗位共享两技能
    const skillsOf = (o: (typeof occs)[number]) =>
      g.relations.filter((e) => e.from === o.id && e.type === 'task_requires_skill').length;
    expect(occs.map(skillsOf)).toEqual([2, 2]);
  });

  it('link heat 权重感知：共现权重和计 heat（sections 形态恒 1 不受影响）', async () => {
    // 手工产业图谱：岗位→技能 权重 2 且未关联课程 → gap heat=2
    const industry: CourseKnowledgeGraph = {
      schemaVersion: '1.2',
      entities: [
        { id: 'occ-1', kind: 'concept', label: '质检工程师', level: 0, order: 0, nodeType: 'occupation' },
        { id: 'sk-1', kind: 'concept', label: '色谱玄学', level: 0, order: 1, nodeType: 'skill' },
      ],
      relations: [{ id: 'e1', from: 'occ-1', to: 'sk-1', type: 'task_requires_skill', weight: 2 }],
      hierarchy: [],
      prerequisiteGraph: { nodes: ['occ-1', 'sk-1'], edges: [], topoOrder: [] },
    };
    const r = await linkKnowledgeIndustry({ courseGraph: courseGraph(), industryGraph: industry });
    const gap = r.data!.gaps.find((g) => g.label === '色谱玄学')!;
    expect(gap.heat).toBe(2);
    expect(gap.demandedByOccupations).toEqual(['质检工程师']);
    // 双岗位各权重 1 → heat=2（既有 GLP 断言语义保持）
    const r2 = await linkKnowledgeIndustry({ courseGraph: courseGraph(), industryGraph: await (await buildIndustryGraph({ sections: INDUSTRY_SECTIONS })).data! });
    expect(r2.data!.gaps.find((g) => g.label === 'GLP 规范')!.heat).toBe(2);
  });
});
