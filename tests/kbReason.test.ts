import { describe, expect, it } from 'vitest';
import { buildTeachingKnowledgeBase } from '../core/kb/buildTeachingKnowledgeBase.js';
import { kbRetrieve } from '../core/kb/kbRetrieve.js';
import { validateLogicalForm } from '../core/kb/kbReason/lfValidator.js';
import { executeLogicalForm } from '../core/kb/kbReason/lfExecutor.js';
import { buildPlannerPrompt, planLogicalForm } from '../core/kb/kbReason/lfPlanner.js';
import { LF_OPERATORS, measureLf } from '../core/kb/kbReason/lfGrammar.js';
import type { ParseCourseMaterialOutput } from '../core/nlp/parseCourseMaterial.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import type { TeachingKnowledgeBase } from '../core/kb/kbTypes.js';
import type { LLMProvider } from '../core/llm.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

/** 多跳夹具：先修链 d→b→c，related 网 a-b/a-c/b-e/c-f/a-g/g-h；g/h 无证据（缺口） */
function fixtureKb(): TeachingKnowledgeBase {
  const texts = [
    '光合作用总述：光能转化为化学能。', // p0 → a
    '光反应在类囊体膜上进行。', // p1 → b,d
    '碳反应即卡尔文循环固定二氧化碳。', // p2 → c,f
    'ATP 是光反应的产物之一。', // p3 → e,b
  ];
  const parse: ParseCourseMaterialOutput = {
    structuredSections: [{ title: '第一章', level: 1, order: 0 }],
    paragraphs: texts.map((text, index) => ({ index, text, sectionOrder: 0 })),
    tables: [],
    knowledgePointCandidates: [],
    llmFilterReport: { enabled: false } as never,
  };
  const graph: CourseKnowledgeGraph = {
    schemaVersion: '1.2',
    entities: [
      { id: 'con-a', kind: 'concept', label: '光合作用', level: 0, order: 0, confidence: 0.9, source: { sectionOrder: [0], paragraphIndexes: [0] } },
      { id: 'con-b', kind: 'concept', label: '光反应', level: 0, order: 1, confidence: 0.8, source: { sectionOrder: [0], paragraphIndexes: [1, 3] } },
      { id: 'con-c', kind: 'concept', label: '碳反应', level: 0, order: 2, confidence: 0.7, source: { sectionOrder: [0], paragraphIndexes: [2] } },
      { id: 'con-d', kind: 'concept', label: '类囊体膜', level: 0, order: 3, confidence: 0.6, source: { sectionOrder: [0], paragraphIndexes: [1] } },
      { id: 'con-e', kind: 'concept', label: 'ATP', level: 0, order: 4, confidence: 0.6, source: { sectionOrder: [0], paragraphIndexes: [3] } },
      { id: 'con-f', kind: 'concept', label: '卡尔文循环', level: 0, order: 5, confidence: 0.5, source: { sectionOrder: [0], paragraphIndexes: [2] } },
      { id: 'con-g', kind: 'concept', label: '光呼吸', level: 0, order: 6, confidence: 0.3, source: { sectionOrder: [0], paragraphIndexes: [] } },
      { id: 'con-h', kind: 'concept', label: 'CAM 植物', level: 0, order: 7, confidence: 0.2, source: { sectionOrder: [0], paragraphIndexes: [] } },
    ],
    relations: [
      { id: 'r1', from: 'con-d', to: 'con-b', type: 'prerequisite', weight: 1 },
      { id: 'r2', from: 'con-b', to: 'con-c', type: 'prerequisite', weight: 1 },
      { id: 'r3', from: 'con-a', to: 'con-b', type: 'related', weight: 2 },
      { id: 'r4', from: 'con-a', to: 'con-c', type: 'related', weight: 2 },
      { id: 'r5', from: 'con-b', to: 'con-e', type: 'related', weight: 1 },
      { id: 'r6', from: 'con-c', to: 'con-f', type: 'related', weight: 1 },
      { id: 'r7', from: 'con-a', to: 'con-g', type: 'related', weight: 1 },
      { id: 'r8', from: 'con-g', to: 'con-h', type: 'related', weight: 1 },
    ],
    hierarchy: [],
    prerequisiteGraph: { nodes: [], edges: [], topoOrder: [] },
  };
  return buildTeachingKnowledgeBase({
    materials: [{ materialId: 'm1', parse }],
    graph,
    options: { builtAt: '2026-11-27T00:00:00.000Z' },
  }).data!;
}

describe('lfGrammar/lfValidator：注册表与确定性校验', () => {
  it('注册表 8 算子齐备且手册非空（演进=加注册项）', () => {
    expect([...LF_OPERATORS.keys()].sort()).toEqual(['COMPARE', 'COUNT', 'FILTER', 'FIND', 'GAP', 'RETRIEVE', 'SORT', 'TRAVERSE']);
    for (const op of LF_OPERATORS.values()) expect(op.manual.length).toBeGreaterThan(10);
  });

  it('合法嵌套计划通过；measureLf 计数正确', () => {
    const plan = { op: 'RETRIEVE', args: { conceptIds: { op: 'TRAVERSE', args: { from: { op: 'FIND', args: { entity: 'concept', where: { labelContains: '光反应' } } }, edge: 'prerequisite', depth: 2 } } } };
    const v = validateLogicalForm(plan);
    expect(v.ok).toBe(true);
    expect(measureLf(plan)).toEqual({ ops: 3, depth: 3 });
  });

  it('未知算子拒绝（白名单外）', () => {
    const v = validateLogicalForm({ op: 'DELETE_ALL', args: {} });
    expect(v.ok).toBe(false);
    expect((v as { errors: string[] }).errors[0]).toContain('未知算子');
  });

  it('字段白名单外拒绝（FILTER/SORT）', () => {
    const bad = { op: 'FILTER', args: { of: { op: 'FIND', args: { entity: 'concept' } }, field: 'password', equals: 'x' } };
    const v = validateLogicalForm(bad);
    expect(v.ok).toBe(false);
    expect((v as { errors: string[] }).errors[0]).toContain('白名单');
  });

  it('超深嵌套拒绝（>3 跳）；超算子数拒绝（>8）', () => {
    let deep: unknown = { op: 'FIND', args: { entity: 'concept' } };
    for (let i = 0; i < 4; i++) deep = { op: 'COUNT', args: { of: deep } };
    expect(validateLogicalForm(deep).ok).toBe(false);
    const many = {
      op: 'COMPARE',
      args: {
        a: { op: 'COUNT', args: { of: { op: 'FILTER', args: { of: { op: 'FILTER', args: { of: { op: 'FIND', args: { entity: 'concept' } }, field: 'origin', equals: 'corpus' } }, field: 'origin', equals: 'corpus' } } } },
        b: { op: 'COUNT', args: { of: { op: 'FILTER', args: { of: { op: 'FILTER', args: { of: { op: 'FIND', args: { entity: 'evidence' } }, field: 'origin', equals: 'corpus' } }, field: 'origin', equals: 'corpus' } } } },
      },
    };
    expect(measureLf(many).ops).toBeGreaterThan(8);
    expect(validateLogicalForm(many).ok).toBe(false);
  });

  it('参数结构非法拒绝（TRAVERSE edge/depth）', () => {
    expect(validateLogicalForm({ op: 'TRAVERSE', args: { from: ['con-a'], edge: 'contains' } }).ok).toBe(false);
    expect(validateLogicalForm({ op: 'TRAVERSE', args: { from: ['con-a'], edge: 'prerequisite', depth: 9 } }).ok).toBe(false);
  });
});

describe('lfExecutor：确定性执行与轨迹', () => {
  const kb = fixtureKb();

  it('FIND/TRAVERSE/RETRIEVE/COUNT/GAP/COMPARE/SORT/FILTER 各算子行为正确', () => {
    const run = (plan: unknown) => executeLogicalForm(kb, plan as never).value;
    expect((run({ op: 'FIND', args: { entity: 'concept', where: { labelContains: '光' } } }) as { ids: string[] }).ids).toEqual(['con-a', 'con-b', 'con-g']);
    expect((run({ op: 'TRAVERSE', args: { from: ['con-b'], edge: 'prerequisite', direction: 'out', depth: 1 } }) as { ids: string[] }).ids).toEqual(['con-b', 'con-c']);
    expect((run({ op: 'TRAVERSE', args: { from: ['con-c'], edge: 'prerequisite', direction: 'in', depth: 2 } }) as { ids: string[] }).ids).toEqual(['con-b', 'con-c', 'con-d']);
    const ev = run({ op: 'RETRIEVE', args: { conceptIds: ['con-b'] } }) as { ids: string[] };
    expect(ev.ids).toContain('ev-m1-p1');
    expect((run({ op: 'COUNT', args: { of: { op: 'GAP', args: {} } } }) as { value: number }).value).toBe(2);
    expect((run({ op: 'GAP', args: {} }) as { ids: string[] }).ids).toEqual(['con-h', 'con-g'].sort());
    const cmp = run({ op: 'COMPARE', args: { a: { op: 'COUNT', args: { of: { op: 'FIND', args: { entity: 'concept', where: { labelContains: '光' } } } } }, b: 2 } }) as { a: number; greater: string };
    expect(cmp.a).toBe(3);
    expect(cmp.greater).toBe('a');
    const sorted = run({ op: 'SORT', args: { of: { op: 'FIND', args: { entity: 'concept', where: { labelContains: '光' } } }, field: 'confidence', order: 'desc' } }) as { ids: string[] };
    expect(sorted.ids[0]).toBe('con-a');
    const filtered = run({ op: 'FILTER', args: { of: { op: 'FIND', args: { entity: 'evidence' } }, field: 'origin', equals: 'corpus' } }) as { ids: string[] };
    expect(filtered.ids.length).toBe(4);
  });

  it('确定性：同一逻辑式执行两次结果与轨迹全等', () => {
    const plan = { op: 'RETRIEVE', args: { conceptIds: { op: 'TRAVERSE', args: { from: ['con-c'], edge: 'prerequisite', direction: 'in', depth: 2 } } } } as never;
    const a = executeLogicalForm(kb, plan);
    const b = executeLogicalForm(kb, plan);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('执行轨迹可审计（每步 op/输入输出规模/样例 id）', () => {
    const { trace } = executeLogicalForm(kb, { op: 'COUNT', args: { of: { op: 'FIND', args: { entity: 'concept' } } } } as never);
    expect(trace.length).toBe(2);
    expect(trace[0].op).toBe('FIND');
    expect(trace[1].op).toBe('COUNT');
    expect(trace[1].outputType).toBe('number');
  });

  it('步数硬上限：绕过校验器的失控计划被拒绝', () => {
    let deep: unknown = { op: 'FIND', args: { entity: 'concept' } };
    for (let i = 0; i < 70; i++) deep = { op: 'FILTER', args: { of: deep, field: 'origin', equals: 'corpus' } };
    expect(() => executeLogicalForm(kb, deep as never)).toThrow('硬上限');
  });
});

describe('lfPlanner：LLM 只规划不执行', () => {
  const kb = fixtureKb();

  it('提示词含算子手册（注册表驱动）+ kb 统计 + 问题', () => {
    const prompt = buildPlannerPrompt(kb, '哪些概念没有证据？');
    expect(prompt).toContain('GAP');
    expect(prompt).toContain('TRAVERSE');
    expect(prompt).toContain(`概念 ${kb.stats.concepts} 个`);
    expect(prompt).toContain('哪些概念没有证据？');
  });

  it('LLM 返回合法 JSON → ok；返回非 JSON → error（不抛异常）', async () => {
    const good: LLMProvider = { async complete() { return '```json\n{"op":"GAP","args":{}}\n```'; } };
    const r1 = await planLogicalForm(kb, 'q', good);
    expect(r1.ok).toBe(true);
    expect(validateLogicalForm(r1.plan).ok).toBe(true);
    const bad: LLMProvider = { async complete() { return '我觉得这个问题……'; } };
    const r2 = await planLogicalForm(kb, 'q', bad);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('规划失败');
  });
});

describe('query mode:reason 端到端（LocalAdapter + 假 LLM 规划器）', () => {
  const kb = fixtureKb();
  const lfByQuestion: Record<string, unknown> = {
    '哪些概念还没有证据': { op: 'GAP', args: {} },
    '光反应的先修链': { op: 'TRAVERSE', args: { from: { op: 'FIND', args: { entity: 'concept', where: { labelContains: '光反应' } } }, edge: 'prerequisite', direction: 'in', depth: 2 } },
  };
  const fakeLlm: LLMProvider = {
    async complete(prompt: string) {
      for (const [q, lf] of Object.entries(lfByQuestion)) {
        if (prompt.includes(q)) return JSON.stringify(lf);
      }
      return '无法规划';
    },
  };

  it('reason 成功：logicalForm + trace + 解析答案（概念带标签）', async () => {
    const adapter = new LocalAdapter({ llm: fakeLlm });
    const r = await adapter.invokeSkill('query_teaching_knowledge_base', {
      inputs: { kb, query: '哪些概念还没有证据', mode: 'reason' },
    });
    expect(r.level).toBe('full');
    const data = r.data as { mode: string; logicalForm: { op: string }; answer: { type: string; ids: string[]; items: Array<{ label?: string }> }; trace: unknown[]; planCacheHit: boolean };
    expect(data.mode).toBe('reason');
    expect(data.logicalForm.op).toBe('GAP');
    expect(data.answer.ids).toEqual(['con-g', 'con-h'].sort());
    expect(data.answer.items.some((i) => i.label === '光呼吸')).toBe(true);
    expect(data.trace.length).toBeGreaterThan(0);
  });

  it('计划缓存：同 query+kb 二次调用 planCacheHit=true 且 LLM 只调一次', async () => {
    let calls = 0;
    const counting: LLMProvider = { async complete(p) { calls += 1; return fakeLlm.complete(p); } };
    const adapter = new LocalAdapter({ llm: counting });
    const q = '光反应的先修链';
    await adapter.invokeSkill('query_teaching_knowledge_base', { inputs: { kb, query: q, mode: 'reason' } });
    const second = await adapter.invokeSkill('query_teaching_knowledge_base', { inputs: { kb, query: q, mode: 'reason' } });
    expect(calls).toBe(1);
    expect((second.data as { planCacheHit: boolean }).planCacheHit).toBe(true);
  });

  it('无 LLM → 回落 retrieve 并如实标注（不抛错）', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('query_teaching_knowledge_base', {
      inputs: { kb, query: '哪些概念还没有证据', mode: 'reason' },
    });
    expect(r.level).toBe('full');
    expect(r.degradationNote).toContain('降级为 retrieve');
    const data = r.data as { mode?: string; evidencePack?: { items: unknown[] } };
    expect(data.mode).toBe('reason-fallback');
    expect(data.evidencePack).toBeTruthy();
  });

  it('LLM 返回非法计划 → 校验拒绝回落 retrieve 并注明原因', async () => {
    const evil: LLMProvider = { async complete() { return '{"op":"DROP_TABLE","args":{}}'; } };
    const adapter = new LocalAdapter({ llm: evil });
    const r = await adapter.invokeSkill('query_teaching_knowledge_base', {
      inputs: { kb, query: '删掉一切', mode: 'reason' },
    });
    expect(r.degradationNote).toContain('校验拒绝');
    expect((r.data as { mode?: string }).mode).toBe('reason-fallback');
  });
});

describe('R25b 补例：边界与解析细节', () => {
  const kb = fixtureKb();

  it('COMPARE 相等分支：greater=equal 且 diff=0', () => {
    const { value } = executeLogicalForm(kb, { op: 'COMPARE', args: { a: 2, b: { op: 'COUNT', args: { of: { op: 'GAP', args: {} } } } } } as never);
    expect(value.type).toBe('comparison');
    expect((value as { greater: string }).greater).toBe('equal');
    expect((value as { diff: number }).diff).toBe(0);
  });

  it('reason 答案的证据解析带 citation/origin（可审计）', async () => {
    const llm: LLMProvider = { async complete() { return '{"op":"RETRIEVE","args":{"conceptIds":["con-b"]}}'; } };
    const adapter = new LocalAdapter({ llm });
    const r = await adapter.invokeSkill('query_teaching_knowledge_base', {
      inputs: { kb, query: '光反应的证据（审计版）', mode: 'reason' },
    });
    const answer = (r.data as { answer: { type: string; items: Array<{ evidenceId: string; citation: Record<string, unknown>; origin: string }> } }).answer;
    expect(answer.type).toBe('evidence');
    expect(answer.items[0].origin).toBe('corpus');
    expect(answer.items[0].citation).toEqual({});
  });

  it('planner 提示词含 few-shot 示例与嵌套/算子数约束（注册表手册之外的结构护栏）', () => {
    const prompt = buildPlannerPrompt(kb, '任意问题');
    expect(prompt).toContain('嵌套不超过 3 层');
    expect(prompt).toContain('算子总数不超过 8');
    expect(prompt).toContain('示例：');
  });

  it('FILTER 数值等值比较（String 归一）：tokenCount 过滤可用', () => {
    const anyEv = kb.evidence[0];
    const { value } = executeLogicalForm(kb, {
      op: 'FILTER',
      args: { of: { op: 'FIND', args: { entity: 'evidence' } }, field: 'tokenCount', equals: anyEv.tokenCount },
    } as never);
    expect(value.type).toBe('evidence');
    expect((value as { ids: string[] }).ids).toContain(anyEv.id);
  });
});

describe('多跳 golden 集评测（SPEC §7：reason ≥ retrieve +15% 相对提升）', () => {
  const kb = fixtureKb();
  /**
   * 16 题多跳/聚合/比较 golden 集。planner 为"完美规划"桩（每题给定正确 LF）——
   * 本评测锁定的是**推理机械**（语法/校验/执行）相对固定管线检索的结构能力优势；
   * 真实 LLM 规划质量经 scripts/eval（env-gated）真机报告，不进 CI 门槛。
   */
  const GOLDEN: Array<{ q: string; lf: unknown; expectIds?: string[]; expectNumber?: number }> = [
    { q: '带光的 concept 有哪些', lf: { op: 'FIND', args: { entity: 'concept', where: { labelContains: '光' } } }, expectIds: ['con-a', 'con-b', 'con-g'] },
    { q: '光反应的直接后继', lf: { op: 'TRAVERSE', args: { from: ['con-b'], edge: 'prerequisite', direction: 'out', depth: 1 } }, expectIds: ['con-b', 'con-c'] },
    { q: '碳反应的两跳先修链', lf: { op: 'TRAVERSE', args: { from: ['con-c'], edge: 'prerequisite', direction: 'in', depth: 2 } }, expectIds: ['con-b', 'con-c', 'con-d'] },
    { q: '光合作用的相关概念', lf: { op: 'TRAVERSE', args: { from: ['con-a'], edge: 'related', direction: 'both', depth: 1 } }, expectIds: ['con-a', 'con-b', 'con-c', 'con-g'] },
    { q: '光反应概念的证据', lf: { op: 'RETRIEVE', args: { conceptIds: ['con-b'] } }, expectIds: ['ev-m1-p1', 'ev-m1-p3'] },
    { q: '带光概念有几个', lf: { op: 'COUNT', args: { of: { op: 'FIND', args: { entity: 'concept', where: { labelContains: '光' } } } } }, expectNumber: 3 },
    { q: '碳反应证据有几条', lf: { op: 'COUNT', args: { of: { op: 'RETRIEVE', args: { conceptIds: ['con-c'] } } } }, expectNumber: 1 },
    { q: '哪些概念缺证据', lf: { op: 'GAP', args: {} }, expectIds: ['con-g', 'con-h'] },
    { q: '光呼吸邻域里的缺口', lf: { op: 'GAP', args: { conceptIds: { op: 'TRAVERSE', args: { from: ['con-g'], edge: 'related', direction: 'both', depth: 1 } } } }, expectIds: ['con-g', 'con-h'] },
    { q: '带光概念数与缺口数比较', lf: { op: 'COMPARE', args: { a: { op: 'COUNT', args: { of: { op: 'FIND', args: { entity: 'concept', where: { labelContains: '光' } } } } }, b: { op: 'COUNT', args: { of: { op: 'GAP', args: {} } } } } }, expectNumber: 1 }, // greater=a → 1
    { q: '先修链上概念的证据汇总', lf: { op: 'RETRIEVE', args: { conceptIds: { op: 'TRAVERSE', args: { from: ['con-c'], edge: 'prerequisite', direction: 'in', depth: 1 } } } }, expectIds: ['ev-m1-p1', 'ev-m1-p2', 'ev-m1-p3'] },
    { q: '按置信度排序带光概念', lf: { op: 'SORT', args: { of: { op: 'FIND', args: { entity: 'concept', where: { labelContains: '光' } } }, field: 'confidence', order: 'desc' } }, expectIds: ['con-a', 'con-b', 'con-g'] },
    { q: 'ATP 有没有先修', lf: { op: 'TRAVERSE', args: { from: ['con-e'], edge: 'prerequisite', direction: 'in', depth: 2 } }, expectIds: ['con-e'] },
    { q: '缺口概念计数', lf: { op: 'COUNT', args: { of: { op: 'GAP', args: {} } } }, expectNumber: 2 },
    { q: ' corpus 来源证据有哪些', lf: { op: 'FILTER', args: { of: { op: 'FIND', args: { entity: 'evidence' } }, field: 'origin', equals: 'corpus' } }, expectIds: ['ev-m1-p0', 'ev-m1-p1', 'ev-m1-p2', 'ev-m1-p3'] },
    { q: '提到 ATP 的证据', lf: { op: 'FIND', args: { entity: 'evidence', where: { labelContains: 'ATP' } } }, expectIds: ['ev-m1-p3'] },
  ];

  it(`golden 集 ${GOLDEN.length} 题：reason（完美规划）命中率 100% 且 ≥ retrieve +15% 相对提升`, () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(15);
    let reasonHits = 0;
    let retrieveHits = 0;
    for (const g of GOLDEN) {
      // reason：执行正确 LF
      const v = validateLogicalForm(g.lf);
      expect(v.ok).toBe(true);
      const { value } = executeLogicalForm(kb, v.ok ? v.plan : (g.lf as never));
      let hit = false;
      if (g.expectNumber !== undefined) {
        const n = value.type === 'number' ? value.value : value.type === 'comparison' ? (value.greater === 'a' ? 1 : 0) : NaN;
        hit = n === g.expectNumber;
      } else if (value.type === 'concepts' || value.type === 'evidence') {
        hit = JSON.stringify(value.ids) === JSON.stringify([...g.expectIds!].sort());
      }
      if (hit) reasonHits += 1;
      // retrieve：同一问题走固定管线，命中=期望 id 全部出现在证据包（数值题结构性无法回答）
      const pack = kbRetrieve(kb, g.q, { topK: 10 });
      const packIds = new Set([...pack.items.map((i) => i.evidenceId), ...pack.concepts.map((c) => c.id)]);
      const rHit = g.expectIds !== undefined && g.expectIds.every((id) => packIds.has(id));
      if (rHit) retrieveHits += 1;
    }
    const reasonRate = reasonHits / GOLDEN.length;
    const retrieveRate = retrieveHits / GOLDEN.length;
    expect(reasonRate).toBe(1);
    expect(reasonRate).toBeGreaterThanOrEqual(retrieveRate * 1.15);
  });
});
