import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTeachingKnowledgeBase } from '../core/kb/buildTeachingKnowledgeBase.js';
import type { ParseCourseMaterialOutput } from '../core/nlp/parseCourseMaterial.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

function parseOf(paragraphs: Array<{ index: number; text: string; sectionOrder?: number }>): ParseCourseMaterialOutput {
  return {
    structuredSections: [{ title: '第一章', level: 1, order: 0 }],
    paragraphs: paragraphs.map((p) => ({ index: p.index, text: p.text, sectionOrder: p.sectionOrder ?? 0 })),
    tables: [],
    knowledgePointCandidates: [],
    llmFilterReport: { enabled: false } as never,
  };
}

function graphOf(): CourseKnowledgeGraph {
  return {
    schemaVersion: '1.2',
    entities: [
      { id: 'con-a', kind: 'concept', label: '光合作用', level: 0, order: 0, confidence: 0.9, source: { sectionOrder: [0], paragraphIndexes: [0, 1, 2] } },
      { id: 'con-b', kind: 'concept', label: '光反应', level: 0, order: 1, confidence: 0.8, source: { sectionOrder: [0], paragraphIndexes: [0, 1] } },
      { id: 'con-c', kind: 'concept', label: '碳反应', level: 0, order: 2, confidence: 0.7, source: { sectionOrder: [0], paragraphIndexes: [0, 2] } },
      { id: 'con-e', kind: 'concept', label: '光呼吸作用', level: 0, order: 3, confidence: 0.3, source: { sectionOrder: [0], paragraphIndexes: [] } },
      { id: 'sec-0', kind: 'section', label: '第一章', level: 1, order: 0 },
    ],
    relations: [
      { id: 'e1', from: 'sec-0', to: 'con-a', type: 'contains', weight: 1 },
      { id: 'e2', from: 'con-b', to: 'con-c', type: 'prerequisite', weight: 1 },
      { id: 'e3', from: 'con-a', to: 'con-b', type: 'related', weight: 2 },
      { id: 'e4', from: 'con-a', to: 'con-c', type: 'related', weight: 2 },
    ],
    hierarchy: [],
    prerequisiteGraph: { nodes: [], edges: [], topoOrder: [] },
  };
}

const PARAS = [
  { index: 0, text: '光合作用分为光反应和碳反应两个阶段。' },
  { index: 1, text: '光反应在类囊体膜上进行，产生 ATP 和 NADPH。' },
  { index: 2, text: '碳反应即卡尔文循环，固定二氧化碳合成有机物。' },
];

function buildDefault(extra: Record<string, unknown> = {}) {
  return buildTeachingKnowledgeBase({
    materials: [{ materialId: 'm1', parse: parseOf(PARAS) }],
    graph: graphOf(),
    options: { builtAt: '2026-11-27T00:00:00.000Z' },
    ...extra,
  });
}

describe('buildTeachingKnowledgeBase：构建与关联', () => {
  it('概念承袭图谱实体（origin=corpus，section 节点不进概念层）', () => {
    const r = buildDefault();
    expect(r.level).toBe('full');
    const kb = r.data!;
    expect(kb.concepts.map((c) => c.id)).toEqual(['con-a', 'con-b', 'con-c', 'con-e']);
    expect(kb.concepts.every((c) => c.origin === 'corpus')).toBe(true);
    expect(kb.concepts.find((c) => c.id === 'con-a')!.confidence).toBe(0.9);
  });

  it('证据=段落级证据块，id 确定性（ev-<materialId>-p<index>）', () => {
    const kb = buildDefault().data!;
    expect(kb.evidence.map((e) => e.id)).toEqual(['ev-m1-p0', 'ev-m1-p1', 'ev-m1-p2']);
    expect(kb.evidence[0].tokenCount).toBeGreaterThan(0);
    expect(kb.evidence.every((e) => e.origin === 'corpus')).toBe(true);
  });

  it('单材料：EntitySource 索引直映射 + 标签包含匹配并集挂接', () => {
    const kb = buildDefault().data!;
    expect(kb.links.conceptToEvidence['con-b']).toEqual(expect.arrayContaining(['ev-m1-p0', 'ev-m1-p1']));
    expect(kb.links.conceptToEvidence['con-c']).toEqual(expect.arrayContaining(['ev-m1-p0', 'ev-m1-p2']));
    // 反向回填一致
    expect(kb.evidence.find((e) => e.id === 'ev-m1-p1')!.conceptIds).toContain('con-b');
  });

  it('coverageGaps：无证据概念入缺口清单（不凑数）', () => {
    const kb = buildDefault().data!;
    expect(kb.stats.coverageGaps).toEqual(['con-e']);
    expect(kb.links.conceptToEvidence['con-e']).toEqual([]);
  });

  it('citation 缺失字段如实缺省（未提供不补造）；提供则透传', () => {
    const r = buildTeachingKnowledgeBase({
      materials: [
        { materialId: 'm1', parse: parseOf(PARAS) },
        { materialId: 'abs1', parse: parseOf([{ index: 0, text: '摘要：光反应新机制研究。' }]), origin: 'abstractCollection', citation: { venue: '青年生态学论坛', year: 2026 } },
      ],
      graph: graphOf(),
      options: { builtAt: '2026-11-27T00:00:00.000Z' },
    });
    const kb = r.data!;
    const corpusEv = kb.evidence.find((e) => e.id === 'ev-m1-p0')!;
    expect(corpusEv.citation).toEqual({});
    const absEv = kb.evidence.find((e) => e.id === 'ev-abs1-p0')!;
    expect(absEv.origin).toBe('abstractCollection');
    expect(absEv.citation).toEqual({ venue: '青年生态学论坛', year: 2026 });
    expect(absEv.citation.url).toBeUndefined();
    expect(kb.stats.externalRatio).toBeCloseTo(1 / 4);
  });

  it('itemToConcept wordfamily 挂接：命中确定性、未命中如实不挂', () => {
    const r = buildTeachingKnowledgeBase({
      materials: [{ materialId: 'm1', parse: parseOf(PARAS) }],
      graph: graphOf(),
      assessments: [{ id: 'q1', question: '光反应产生什么？', options: ['ATP 和 NADPH', '葡萄糖'] }],
      qaPairs: [
        { id: 'qa1', question: '什么是碳反应？', answer: '卡尔文循环。' },
        { id: 'qa2', question: '完全无关的问题？', answer: '无关答案。' },
      ],
      options: { builtAt: '2026-11-27T00:00:00.000Z' },
    });
    const links = r.data!.links.itemToConcept;
    expect(links.some((l) => l.itemId === 'q1' && l.conceptId === 'con-b' && l.linkProvenance === 'wordfamily')).toBe(true);
    expect(links.some((l) => l.itemId === 'qa1' && l.conceptId === 'con-c')).toBe(true);
    expect(links.some((l) => l.itemId === 'qa2')).toBe(false);
    expect(links.every((l) => l.mustReview === false)).toBe(true);
  });

  it('evidenceToEvidence 共享概念关联（weight=共享概念数）且每节点限额', () => {
    const kb = buildDefault().data!;
    const p0p1 = kb.links.evidenceToEvidence.find((l) => l.from === 'ev-m1-p0' && l.to === 'ev-m1-p1');
    expect(p0p1).toBeTruthy();
    expect(p0p1!.weight).toBeGreaterThanOrEqual(1);
    expect(p0p1!.via).toBe('sharedConcept');
  });

  it('确定性：同输入同输出（kbId/证据/关联/索引全等）', () => {
    const a = buildDefault().data!;
    const b = buildDefault().data!;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('顶层 kbId 契约入参生效（回归：曾只读 options.kbId 静默忽略契约入参）', () => {
    const r = buildTeachingKnowledgeBase({
      materials: [{ materialId: 'm1', parse: parseOf(PARAS) }],
      graph: graphOf(),
      kbId: 'eco-ch01',
    });
    expect(r.data!.kbId).toBe('eco-ch01');
    // options.kbId 优先于顶层（core API 显式位）
    const r2 = buildTeachingKnowledgeBase({
      materials: [{ materialId: 'm1', parse: parseOf(PARAS) }],
      graph: graphOf(),
      kbId: 'eco-ch01',
      options: { kbId: 'explicit-opt' },
    });
    expect(r2.data!.kbId).toBe('explicit-opt');
    // 缺省仍按材料哈希派生
    const r3 = buildTeachingKnowledgeBase({
      materials: [{ materialId: 'm1', parse: parseOf(PARAS) }],
      graph: graphOf(),
    });
    expect(r3.data!.kbId).toMatch(/^kb-/);
  });

  it('坏输入返回 degraded 空骨架 + 引导，不抛异常', () => {
    const r = buildTeachingKnowledgeBase({ materials: [], graph: null as never });
    expect(r.level).toBe('degraded');
    expect(r.degradationNote).toContain('空 KB 骨架');
    expect(r.data!.concepts).toEqual([]);
    expect(r.data!.stats.evidence).toBe(0);
  });

  it('stats：materials/concepts/evidence 计数正确', () => {
    const kb = buildDefault().data!;
    expect(kb.stats.materials).toBe(1);
    expect(kb.stats.concepts).toBe(4);
    expect(kb.stats.evidence).toBe(3);
    expect(kb.stats.externalRatio).toBe(0);
  });
});

describe('build/query 执行器集成（持久化往返 + 注册接线）', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('build persist 落盘 → query kbId 加载 → 证据包返回（configDir 隔离）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nangying-kb-'));
    process.env.NANGYING_CONFIG_DIR = dir;
    try {
      const adapter = new LocalAdapter();
      const built = await adapter.invokeSkill('build_teaching_knowledge_base', {
        inputs: {
          materials: [{ materialId: 'm1', parse: parseOf(PARAS) }],
          graph: graphOf(),
        },
      });
      expect(built.level).toBe('full');
      const persisted = (built.data as { persisted?: string }).persisted!;
      expect(persisted).toContain(join('kb', ''));
      expect(existsSync(persisted)).toBe(true);
      const onDisk = JSON.parse(readFileSync(persisted, 'utf8'));
      expect(onDisk.schemaId).toBe('nangying-starmap/kb');

      const kbId = onDisk.kbId as string;
      const queried = await adapter.invokeSkill('query_teaching_knowledge_base', {
        inputs: { kbId, query: '光反应 产生什么' },
      });
      expect(queried.level).toBe('full');
      const pack = (queried.data as { evidencePack: { items: Array<{ evidenceId: string }> } }).evidencePack;
      expect(pack.items.length).toBeGreaterThan(0);
      expect(pack.items[0].evidenceId).toMatch(/^ev-m1-p/);
      expect(queried.degradationNote).toContain('已从落盘加载');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('query 缺 kb/kbId → 结构化错误（INVALID_INPUT + 引导）', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('query_teaching_knowledge_base', { inputs: { query: '光合作用' } });
    expect(r.level).toBe('unavailable');
    expect(r.errorCode).toBe('INVALID_INPUT');
    expect(r.degradationNote).toContain('二选一');
  });

  it('query kbId 不存在 → 结构化错误含构建引导', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nangying-kb-'));
    process.env.NANGYING_CONFIG_DIR = dir;
    try {
      const adapter = new LocalAdapter();
      const r = await adapter.invokeSkill('query_teaching_knowledge_base', { inputs: { kbId: 'kb-ghost', query: 'x' } });
      expect(r.level).toBe('unavailable');
      expect(r.degradationNote).toContain('build_teaching_knowledge_base');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('build 缺必填入参 → guarded 结构化错误', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('build_teaching_knowledge_base', { inputs: {} });
    expect(r.errorCode).toBe('INVALID_INPUT');
    expect(r.requiredInputs).toEqual(expect.arrayContaining(['materials', 'graph']));
  });
});
