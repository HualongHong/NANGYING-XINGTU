import { describe, expect, it } from 'vitest';
import {
  CONCEPT_ORIGINS,
  EVIDENCE_ORIGINS,
  ITEM_KINDS,
  KB_ENTITY_FIELDS,
  KB_LIMITS,
  KB_PREDICATES,
  KB_SCHEMA_ID,
  KB_SCHEMA_VERSION,
  LINK_PROVENANCES,
} from '../core/kb/kbSchema.js';
import { buildTeachingKnowledgeBase, validateTeachingKnowledgeBase } from '../core/kb/buildTeachingKnowledgeBase.js';
import type { TeachingKnowledgeBase } from '../core/kb/kbTypes.js';

function minimalKb(): TeachingKnowledgeBase {
  const r = buildTeachingKnowledgeBase({
    materials: [{ materialId: 'm1', parse: { structuredSections: [], paragraphs: [{ index: 0, text: '光合作用。', sectionOrder: -1 }], tables: [], knowledgePointCandidates: [], llmFilterReport: { enabled: false } as never } }],
    graph: {
      entities: [{ id: 'con-a', kind: 'concept', label: '光合作用', level: 0, order: 0, source: { sectionOrder: [0], paragraphIndexes: [0] } }],
      relations: [],
      hierarchy: [],
      prerequisiteGraph: { nodes: [], edges: [], topoOrder: [] },
    },
    options: { builtAt: '2026-11-27T00:00:00.000Z' },
  });
  return r.data!;
}

describe('KB 声明式 schema（§4.7 schema-first：数据即单一事实源）', () => {
  it('枚举非空且值唯一', () => {
    for (const list of [CONCEPT_ORIGINS, EVIDENCE_ORIGINS, LINK_PROVENANCES, ITEM_KINDS]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
    expect(CONCEPT_ORIGINS).toContain('corpus');
    expect(CONCEPT_ORIGINS).toContain('external');
    expect(CONCEPT_ORIGINS).toContain('inferred');
  });

  it('谓词声明：名称唯一、端点类型合法、via 枚举非空', () => {
    const names = KB_PREDICATES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of KB_PREDICATES) {
      expect(['concept', 'evidence', 'item']).toContain(p.from);
      expect(['concept', 'evidence']).toContain(p.to);
      if (p.via) expect(p.via.length).toBeGreaterThan(0);
    }
    expect(names).toEqual(expect.arrayContaining(['conceptToEvidence', 'evidenceToEvidence', 'itemToConcept']));
  });

  it('护栏上限为正数且深度 ≤3（KAG-lite 约束先行声明）', () => {
    expect(KB_LIMITS.maxTraverseDepth).toBeLessThanOrEqual(3);
    expect(KB_LIMITS.maxPlanOps).toBeGreaterThan(0);
    expect(KB_LIMITS.maxExecutorSteps).toBeGreaterThan(KB_LIMITS.maxPlanOps);
    expect(KB_LIMITS.defaultBudgetTokens).toBeGreaterThan(0);
  });

  it('实体字段白名单覆盖 citation 六字段（未提供不补造的载体）', () => {
    expect(KB_ENTITY_FIELDS.citation).toEqual(['url', 'doi', 'venue', 'year', 'retrievedAt', 'license']);
  });
});

describe('validateTeachingKnowledgeBase（schema 驱动校验）', () => {
  it('合法 KB 零违规', () => {
    const kb = minimalKb();
    expect(kb.schemaId).toBe(KB_SCHEMA_ID);
    expect(kb.schemaVersion).toBe(KB_SCHEMA_VERSION);
    expect(validateTeachingKnowledgeBase(kb)).toEqual([]);
  });

  it('非法概念 origin 被抓出', () => {
    const kb = minimalKb();
    (kb.concepts[0] as { origin: string }).origin = 'martian';
    expect(validateTeachingKnowledgeBase(kb).some((v) => v.includes('origin 非法'))).toBe(true);
  });

  it('证据 citation 白名单外字段被抓出', () => {
    const kb = minimalKb();
    (kb.evidence[0].citation as Record<string, unknown>).fabricated = 'x';
    expect(validateTeachingKnowledgeBase(kb).some((v) => v.includes('白名单外字段'))).toBe(true);
  });

  it('conceptToEvidence 引用不存在的证据被抓出', () => {
    const kb = minimalKb();
    kb.links.conceptToEvidence['con-a'] = ['ev-ghost-p9'];
    expect(validateTeachingKnowledgeBase(kb).some((v) => v.includes('不存在的证据'))).toBe(true);
  });

  it('itemToConcept 引用不存在的概念被抓出', () => {
    const kb = minimalKb();
    kb.links.itemToConcept = [{ itemId: 'q1', itemKind: 'qa', conceptId: 'con-ghost', linkProvenance: 'wordfamily', mustReview: false }];
    expect(validateTeachingKnowledgeBase(kb).some((v) => v.includes('不存在的概念'))).toBe(true);
  });
});
