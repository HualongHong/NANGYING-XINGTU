import { describe, expect, it } from 'vitest';
import { generateAssessment } from '../core/qa/generateAssessment.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import type { LLMProvider } from '../core/llm.js';

function graphFixture(): CourseKnowledgeGraph {
  const concepts = ['种群密度', '标志重捕法', '样方调查法', '生态系统', '食物链', '能量流动'];
  return {
    schemaVersion: '1.2',
    entities: concepts.map((label, i) => ({
      id: `con-${i}`, kind: 'concept' as const, label, level: 0, order: i,
      source: { sectionOrder: [0], paragraphIndexes: [i] },
      confidence: 0.9 - i * 0.1,
    })),
    relations: [{ id: 'e1', from: 'con-0', to: 'con-1', type: 'related', weight: 2, provenance: 'heuristic' }],
    hierarchy: [],
    prerequisiteGraph: { nodes: [], edges: [], topoOrder: [] },
  };
}

describe('R4-2 generate_assessment（技能 #22，反馈 a 4.2-N1）', () => {
  it('题册结构齐全：题干/题型/难度/Bloom/答案/评分点，mixed 难度三档轮转', async () => {
    const r = await generateAssessment({ graph: graphFixture(), count: 6, includeExplanations: true, commonErrors: true });
    expect(r.level).toBe('full');
    const items = r.data!.assessment;
    expect(items).toHaveLength(6);
    for (const it of items) {
      expect(it.stem).toContain('「');
      expect(['概念解释', '辨析', '应用']).toContain(it.type);
      expect(['easy', 'medium', 'hard']).toContain(it.difficulty);
      expect(['记忆', '理解', '应用', '分析']).toContain(it.bloom);
      expect(it.answer).toContain('答题要点');
      expect(it.explanation).toBeTruthy();
      expect(it.commonErrors!.length).toBeGreaterThan(0);
      expect(it.scoringPoints.length).toBeGreaterThanOrEqual(3);
      expect(it.conceptIds.length).toBeGreaterThan(0);
    }
    expect(r.data!.stats.byDifficulty.easy).toBe(2);
    expect(r.data!.stats.byDifficulty.medium).toBe(2);
    expect(r.data!.stats.byDifficulty.hard).toBe(2);
    // 辨析题取材 related 目标
    const discrimin = items.find((i) => i.type === '辨析')!;
    expect(discrimin.stem).toContain('标志重捕法');
  });

  it('按置信度选题：低置信概念超出 count 时不出题', async () => {
    const r = await generateAssessment({ graph: graphFixture(), count: 3 });
    const labels = r.data!.assessment.map((i) => i.conceptIds[0]);
    expect(labels).toEqual(['con-0', 'con-1', 'con-2']);
  });

  it('difficulty 固定 + bloomLevels 约束生效', async () => {
    const r = await generateAssessment({
      graph: graphFixture(), count: 4, difficulty: 'hard', bloomLevels: ['应用', '分析'],
    });
    for (const it of r.data!.assessment) {
      expect(it.difficulty).toBe('hard');
      expect(['应用', '分析']).toContain(it.bloom);
    }
  });

  it('LLM 精炼：采用 LLM 题干；失败回落模板题并标 degraded', async () => {
    const llm: LLMProvider = {
      complete: async () => JSON.stringify(
        Array.from({ length: 6 }, (_, i) => ({
          stem: `LLM题干${i}：结合实例说明概念。`,
          type: '应用', difficulty: 'medium', bloom: '应用',
          answer: 'LLM答案要点。', explanation: 'LLM解析。', commonErrors: ['LLM错误1'], scoringPoints: ['LLM评分点'],
        })),
      ),
    };
    const ok = await generateAssessment({ graph: graphFixture(), count: 6 }, { llm });
    expect(ok.level).toBe('full');
    expect(ok.data!.assessment[0].stem).toContain('LLM题干');

    const badLlm: LLMProvider = { complete: async () => '不是JSON' };
    const degraded = await generateAssessment({ graph: graphFixture(), count: 4 }, { llm: badLlm });
    expect(degraded.level).toBe('degraded');
    expect(degraded.degradationNote).toContain('回落模板题');
    expect(degraded.data!.assessment).toHaveLength(4);
  });

  it('形态守卫：非法 graph → unavailable + INVALID_INPUT', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('generate_assessment', { inputs: {} });
    expect(r.level).toBe('unavailable');
    expect(r.errorCode).toBe('INVALID_INPUT');
  });

  it('经适配器端到端：string graph 自动解析', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('generate_assessment', {
      inputs: { graph: JSON.stringify(graphFixture()), count: 2 },
    });
    expect(r.level).toBe('full');
    expect((r.data as { assessment: unknown[] }).assessment).toHaveLength(2);
  });
});
