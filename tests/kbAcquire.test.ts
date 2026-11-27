import { describe, expect, it } from 'vitest';
import { buildTeachingKnowledgeBase, type BuildTeachingKnowledgeBaseOutput } from '../core/kb/buildTeachingKnowledgeBase.js';
import type { ParseCourseMaterialOutput } from '../core/nlp/parseCourseMaterial.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';

function parseOf(texts: string[]): ParseCourseMaterialOutput {
  return {
    structuredSections: [{ title: '第一章', level: 1, order: 0 }],
    paragraphs: texts.map((text, index) => ({ index, text, sectionOrder: 0 })),
    tables: [],
    knowledgePointCandidates: [],
    llmFilterReport: { enabled: false } as never,
  };
}

function graphOf(): CourseKnowledgeGraph {
  return {
    schemaVersion: '1.2',
    entities: [
      { id: 'con-a', kind: 'concept', label: '光合作用', level: 0, order: 0, confidence: 0.9, source: { sectionOrder: [0], paragraphIndexes: [0] } },
      { id: 'con-e', kind: 'concept', label: '光呼吸作用', level: 0, order: 1, confidence: 0.3, source: { sectionOrder: [0], paragraphIndexes: [] } },
    ],
    relations: [{ id: 'e1', from: 'con-a', to: 'con-e', type: 'related', weight: 1 }],
    hierarchy: [],
    prerequisiteGraph: { nodes: [], edges: [], topoOrder: [] },
  };
}

const OPTS = { builtAt: '2026-11-27T00:00:00.000Z' };

function baseKb(): BuildTeachingKnowledgeBaseOutput {
  return buildTeachingKnowledgeBase({
    materials: [{ materialId: 'm1', parse: parseOf(['光合作用分为光反应和碳反应。']) }],
    graph: graphOf(),
    qaPairs: [{ id: 'qa1', question: '什么是光合作用？', answer: '光反应和碳反应。' }],
    options: OPTS,
  }).data!;
}

describe('R25 采集回路：merge 合并扩展', () => {
  it('base + 新材料：证据并入、索引重建、coverageGaps 随证据闭合', () => {
    const base = baseKb();
    expect(base.stats.coverageGaps).toContain('con-e');
    const merged = buildTeachingKnowledgeBase({
      materials: [{ materialId: 'abs1', parse: parseOf(['光呼吸作用是光反应的伴随过程。']), origin: 'abstractCollection', citation: { venue: '青年生态学论坛', year: 2026 } }],
      graph: graphOf(),
      base,
      options: OPTS,
    }).data!;
    expect(merged.kbId).toBe(base.kbId); // 身份承袭
    expect(merged.evidence.map((e) => e.id)).toEqual(['ev-abs1-p0', 'ev-m1-p0']);
    expect(merged.stats.coverageGaps).not.toContain('con-e'); // 缺口闭合
    expect(merged.stats.externalRatio).toBeCloseTo(0.5);
    expect(merged.evidence.find((e) => e.id === 'ev-abs1-p0')!.citation).toEqual({ venue: '青年生态学论坛', year: 2026 });
  });

  it('base 既有挂接承袭（human/llm 状态不丢）；空 materials 合法', () => {
    const base = baseKb();
    const confirmed = buildTeachingKnowledgeBase({
      materials: [],
      graph: graphOf(),
      base,
      llmLinkProposals: [{ itemId: 'qa1', itemKind: 'qa', conceptId: 'con-e' }],
      options: OPTS,
    }).data!;
    expect(confirmed.links.itemToConcept.some((l) => l.itemId === 'qa1' && l.conceptId === 'con-e' && l.linkProvenance === 'llm' && l.mustReview)).toBe(true);
    const reviewed = buildTeachingKnowledgeBase({
      materials: [],
      graph: graphOf(),
      base: confirmed,
      confirmReview: true,
      options: OPTS,
    }).data!;
    const link = reviewed.links.itemToConcept.find((l) => l.itemId === 'qa1' && l.conceptId === 'con-e')!;
    expect(link.linkProvenance).toBe('human');
    expect(link.mustReview).toBe(false);
    expect(reviewed.reviewQueue.filter((r) => r.kind === 'link')).toEqual([]);
  });

  it('confirmReview 数组只确认指定 itemId', () => {
    const base = baseKb();
    const withTwo = buildTeachingKnowledgeBase({
      materials: [],
      graph: graphOf(),
      base,
      qaPairs: [{ id: 'qa2', question: 'x', answer: 'y' }],
      llmLinkProposals: [
        { itemId: 'qa1', itemKind: 'qa', conceptId: 'con-e' },
        { itemId: 'qa2', itemKind: 'qa', conceptId: 'con-e' },
      ],
      options: OPTS,
    }).data!;
    const partial = buildTeachingKnowledgeBase({
      materials: [],
      graph: graphOf(),
      base: withTwo,
      confirmReview: ['qa1'],
      options: OPTS,
    }).data!;
    expect(partial.links.itemToConcept.find((l) => l.itemId === 'qa1' && l.conceptId === 'con-e')!.mustReview).toBe(false);
    expect(partial.links.itemToConcept.find((l) => l.itemId === 'qa2' && l.conceptId === 'con-e')!.mustReview).toBe(true);
  });

  it('externalConcepts：external 建概念（同义不重复）；inferred 入复核队列', () => {
    const base = baseKb();
    const r = buildTeachingKnowledgeBase({
      materials: [],
      graph: graphOf(),
      base,
      externalConcepts: [
        { label: 'CAM 植物', origin: 'external', aliases: ['景天酸代谢植物'] },
        { label: ' 光呼吸作用 ', origin: 'inferred' }, // 与既有 con-e 同义（归一化）→ 不重复建
        { label: '疑似新机制', origin: 'inferred' },
        { label: '', origin: 'external' }, // 空标签拒绝
      ],
      options: OPTS,
    });
    const kb = r.data!;
    const cam = kb.concepts.find((c) => c.label === 'CAM 植物')!;
    expect(cam.origin).toBe('external');
    expect(cam.aliases).toEqual(['景天酸代谢植物']);
    expect(kb.concepts.filter((c) => c.label.includes('光呼吸')).length).toBe(1); // 未重复
    expect(kb.concepts.find((c) => c.label === '疑似新机制')!.origin).toBe('inferred');
    expect(kb.reviewQueue.some((q) => q.kind === 'concept' && q.label === '疑似新机制')).toBe(true);
    expect(r.degradationNote).toContain('外部概念拒绝 1 个');
  });

  it('llmLinkProposals 确定性校验：概念/条目不存在即拒绝并如实报告', () => {
    const r = buildTeachingKnowledgeBase({
      materials: [{ materialId: 'm1', parse: parseOf(['光合作用。']) }],
      graph: graphOf(),
      qaPairs: [{ id: 'qa1', question: 'q', answer: 'a' }],
      llmLinkProposals: [
        { itemId: 'qa1', itemKind: 'qa', conceptId: 'con-ghost' },
        { itemId: 'qa-ghost', itemKind: 'qa', conceptId: 'con-a' },
        { itemId: 'qa1', itemKind: 'qa', conceptId: 'con-a' },
      ],
      options: OPTS,
    });
    const kb = r.data!;
    expect(kb.links.itemToConcept.filter((l) => l.linkProvenance === 'llm').length).toBe(1);
    expect(r.degradationNote).toContain('LLM 挂接提议拒绝 2 条');
  });

  it('acquisitionPlan：缺口概念 → 检索词种子（标签+别名）', () => {
    const base = baseKb();
    const r = buildTeachingKnowledgeBase({
      materials: [],
      graph: graphOf(),
      base,
      externalConcepts: [{ label: 'CAM 植物', origin: 'external', aliases: ['景天酸代谢'] }],
      options: OPTS,
    });
    const plan = r.data!.acquisitionPlan;
    const gapE = plan.find((p) => p.conceptId === 'con-e')!;
    expect(gapE.label).toBe('光呼吸作用');
    expect(gapE.searchTerms).toContain('光呼吸作用');
    const cam = plan.find((p) => p.label === 'CAM 植物')!;
    expect(cam.searchTerms).toEqual(['CAM 植物', '景天酸代谢']);
  });

  it('零虚构引用：merge 后全部 external 证据 citation 只含真实提供字段', () => {
    const base = baseKb();
    const merged = buildTeachingKnowledgeBase({
      materials: [{ materialId: 'abs1', parse: parseOf(['摘要文本。']), origin: 'abstractCollection', citation: { venue: '论坛', year: 2026 } }],
      graph: graphOf(),
      base,
      options: OPTS,
    }).data!;
    for (const ev of merged.evidence.filter((e) => e.origin !== 'corpus')) {
      for (const [k, v] of Object.entries(ev.citation)) {
        expect(['url', 'doi', 'venue', 'year', 'retrievedAt', 'license']).toContain(k);
        expect(v).toBeTruthy(); // 有值必为真实提供；缺失字段不出现（未提供不补造）
      }
      expect(ev.citation.doi).toBeUndefined();
      expect(ev.citation.url).toBeUndefined();
    }
  });
});
