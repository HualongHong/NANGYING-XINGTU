import { describe, expect, it } from 'vitest';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import {
  DEFAULT_WEIGHTS,
  dedupByTitle,
  deriveTermFamiliesHeuristic,
  mergeTermFamilies,
  planSelection,
  scoreRecords,
  selectEvidence,
} from '../core/evidence/selectEvidence.js';

const rec = (id: string, title: string, kw: string[], body: string, session = '分会场 A') => ({
  id, title, keywords: kw, body, affiliations: ['某大学'], session, defects: [] as string[],
});

const RECORDS = [
  rec('R1', '放牧对草原群落稳定性的影响', ['稳定性', '异步性'], '本文研究放牧强度与群落稳定性的关系，发现种群稳定性是主要驱动因素。'),
  rec('R2', '团粒结构形成机制研究', ['团粒结构', '有机质'], '本文分析团粒结构的形成机制。'),
  rec('R3', '土壤质地分类方法综述', ['质地分类'], '综述质地分类方法。'),
  rec('R4', '草地旅游开发策略', ['旅游'], '讨论草原旅游开发，与稳定性无关。'),
  rec('R5', '放牧对草原群落稳定性的影响：Meta 分析', ['稳定性'], '重复主题的不同研究。'),
];

const SECTIONS = [
  { title: '3.1 土壤质地', knowledgePoints: ['质地分类'], confusables: ['地质'] },
  { title: '3.2 土壤结构', knowledgePoints: ['团粒结构', '有机质'], keyPoints: ['团粒结构'] },
];

describe('select_research_evidence（研究例证选文）', () => {
  it('入参校验：sections 缺失/percentile 越界/weights 负值结构化报错', () => {
    expect(planSelection({})).toMatchObject({ ok: false });
    expect(planSelection({ sections: SECTIONS, percentile: 1.5 })).toMatchObject({ ok: false });
    expect(planSelection({ sections: SECTIONS, weights: { title: -1 } })).toMatchObject({ ok: false });
    const ok = planSelection({ sections: SECTIONS });
    expect(ok).toMatchObject({ ok: true, percentile: 0.2, perSectionMin: 1, weights: DEFAULT_WEIGHTS });
  });

  it('启发式词族：核心词=知识点标签，排除词=易混概念，零内置学科词表', () => {
    const plan = planSelection({ sections: SECTIONS });
    if (!plan.ok) throw new Error('unexpected');
    const fams = deriveTermFamiliesHeuristic(plan.sections);
    expect(fams[0].core).toEqual(['质地分类']);
    expect(fams[0].exclusion).toEqual(['地质']);
    expect(fams[1].core).toEqual(['团粒结构', '有机质']);
    expect(fams.every((f) => f.expansion.length === 0)).toBe(true);
  });

  it('LLM 词族并入：核心词兜底不丢，节名对齐，未对齐给说明', () => {
    const base = deriveTermFamiliesHeuristic([
      { title: '3.1 土壤质地', knowledgePoints: ['质地分类'], keyPoints: ['质地分类'], confusables: [], declaredNoHit: false },
    ]);
    const merged = mergeTermFamilies(base, [{ section: '3.1 土壤质地', core: ['粒级'], expansion: ['机械组成'], exclusion: ['岩性'] }]);
    expect(merged.families[0].core).toContain('质地分类');
    expect(merged.families[0].core).toContain('粒级');
    expect(merged.families[0].expansion).toContain('机械组成');
    expect(merged.families[0].exclusion).toContain('岩性');
    expect(merged.note).toContain('1/1');
    const unmatched = mergeTermFamilies(base, [{ section: '不存在节' }]);
    expect(unmatched.families[0].expansion).toEqual([]);
  });

  it('加权评分：题名命中权重最高，排除词降权并标注', () => {
    const fams = [
      { section: 's', core: ['稳定性'], expansion: [], exclusion: ['异步性'] },
    ];
    const scores = scoreRecords([rec('A', '稳定性研究', [], ''), rec('B', '其他研究', [], '本文讨论异步性。')], fams, DEFAULT_WEIGHTS);
    const a = scores.find((s) => s.recordId === 'A')!;
    const b = scores.find((s) => s.recordId === 'B')!;
    expect(a.score).toBe(3);
    expect(b.matchedExclusion).toEqual(['异步性']);
    expect(b.score).toBeLessThan(1);
  });

  it('相对分位阈值入选：题名去重保留高分', () => {
    const r = selectEvidence({ records: RECORDS, sections: [{ title: '草地生态', knowledgePoints: ['稳定性'], keyPoints: ['稳定性'], confusables: [], declaredNoHit: false }], percentile: 0.2 });
    if ('error' in r) throw new Error('unexpected');
    // R5 与 R1 题名同簇：保留高分者 R1
    expect(r.selected.some((s) => s.recordId === 'R1')).toBe(true);
    expect(r.selected.some((s) => s.recordId === 'R5')).toBe(false);
    expect(r.rejected.some((x) => x.recordId === 'R5' && x.reason.includes('题名重复'))).toBe(true);
    expect(r.selected.find((s) => s.recordId === 'R4')).toBeUndefined();
  });

  it('覆盖面约束优先：低于阈值补入标 mustReview，不让热门挤满', () => {
    const r = selectEvidence({
      records: [
        rec('A1', '团粒结构研究', ['团粒结构'], ''),
        rec('A2', '矿化过程研究', ['有机质'], ''),
        rec('B1', '草地稳定性长期观测', ['稳定性'], ''),
        rec('B2', '长期观测方法', [], '稳定性监测数据分析'),
      ],
      sections: [
        { title: '结构', knowledgePoints: ['团粒结构', '有机质'], keyPoints: ['团粒结构'], confusables: [], declaredNoHit: false },
        { title: '稳定性', knowledgePoints: ['稳定性'], keyPoints: ['稳定性'], confusables: [], declaredNoHit: false },
      ],
      percentile: 0.2,
      perSectionMin: 2,
    });
    if ('error' in r) throw new Error('unexpected');
    const a2 = r.selected.find((s) => s.recordId === 'A2')!;
    const b2 = r.selected.find((s) => s.recordId === 'B2')!;
    expect(a2.section).toBe('结构');
    expect(a2.mustReview).toBe(true);
    expect(b2.mustReview).toBe(true);
    expect(r.stats.perSection).toEqual({ 结构: 2, 稳定性: 2 });
    expect(r.stats.mustReview).toBe(2);
  });

  it('收敛四条件：重点无命中与节无落位如实未达', () => {
    const r = selectEvidence({
      records: [rec('X1', '完全无关题名', [], '无关内容')],
      sections: [
        { title: '有命中节', knowledgePoints: ['稳定性'], keyPoints: ['稳定性'], confusables: [], declaredNoHit: false },
        { title: '无落位节', knowledgePoints: ['团粒结构'], keyPoints: ['团粒结构'], confusables: [], declaredNoHit: false },
      ],
    });
    if ('error' in r) throw new Error('unexpected');
    expect(r.convergence.met).toBe(false);
    const c1 = r.convergence.conditions.find((c) => c.id === 'keyPointCoverage')!;
    const c2 = r.convergence.conditions.find((c) => c.id === 'sectionPlacement')!;
    expect(c1.met).toBe(false);
    expect(c2.met).toBe(false);
    expect(c2.detail).toContain('无落位节');
  });

  it('零命中：空选 + 收敛未达 + 扩词族指引，不凑数', () => {
    const r = selectEvidence({ records: [rec('Z1', '量子计算综述', [], '无关内容')], sections: SECTIONS });
    if ('error' in r) throw new Error('unexpected');
    expect(r.selected).toEqual([]);
    expect(r.convergence.met).toBe(false);
    expect(r.convergence.conditions[0].detail).toContain('词族扩展');
  });

  it('declaredNoHit 的节不算落位失败（K2 留白注明以教材为准）', () => {
    const r = selectEvidence({
      records: [rec('S1', '团粒结构研究', ['团粒结构'], '')],
      sections: [
        { title: '结构', knowledgePoints: ['团粒结构'], keyPoints: ['团粒结构'], confusables: [], declaredNoHit: false },
        { title: '质地', knowledgePoints: ['质地分类'], keyPoints: ['质地分类'], confusables: [], declaredNoHit: true },
      ],
    });
    if ('error' in r) throw new Error('unexpected');
    const c2 = r.convergence.conditions.find((c) => c.id === 'sectionPlacement')!;
    expect(c2.met).toBe(true);
  });

  it('dedupByTitle：同簇保留最高分记录', () => {
    const cand = [
      { recordId: 'A', title: '放牧对草原群落稳定性的影响', section: 's', score: 5, percentile: 0, matchedCore: [], matchedExpansion: [], matchedExclusion: [], sourceComplete: true, defects: [] },
      { recordId: 'B', title: '放牧对草原群落稳定性的影响（Meta 分析）', section: 's', score: 9, percentile: 0, matchedCore: [], matchedExpansion: [], matchedExclusion: [], sourceComplete: true, defects: [] },
    ];
    const { kept, duplicates } = dedupByTitle(cand);
    expect(duplicates.get('A')).toBe('B');
    expect(kept.every((k) => k.recordId === 'B')).toBe(true);
  });

  it('执行器冒烟：无 LLM 走启发式词族入选', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('select_research_evidence', {
      inputs: { records: RECORDS.slice(0, 3), sections: SECTIONS },
    });
    expect(r.level).toBe('full');
    const data = r.data as { selected: unknown[]; candidates: unknown[] };
    expect(data.selected.length).toBeGreaterThan(0);
    const bad = await adapter.invokeSkill('select_research_evidence', { inputs: { sections: SECTIONS } });
    expect(bad.level).toBe('unavailable');
  });
});
