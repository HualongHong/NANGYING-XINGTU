import { describe, expect, it } from 'vitest';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

/** 反馈 b 的实验型图谱样例（W02 水质多参数分析） */
const EXPERIMENTAL_INPUT = {
  graphType: 'experimental',
  sections: [
    {
      id: 'W02',
      title: '水质多参数分析',
      fields: {
        标准: ['HJ 1147-2020', 'HJ 506-2009'],
        样品: ['河流—河口 3—5 个站点水样'],
        指标: ['pH', '溶解氧', '氨氮'],
        仪器: ['多参数水质仪', 'CTD'],
        操作链: ['站点布设', '采水', '现场固定', '仪器校准', '实验室测定'],
        质控: ['空白', '平行样'],
        产出: ['水质数据集'],
        难点: ['溶解氧固定与气泡'],
      },
    },
  ],
};

describe('R4-1 实验型知识图谱（反馈 b P0-4）', () => {
  it('八类字段 → 实体与关系齐全，操作链保序，stats.byType 正确', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: EXPERIMENTAL_INPUT,
    });
    expect(r.level).toBe('full');
    const g = r.data as {
      graphType: string;
      nodes: Array<{ id: string; type: string; label: string; order?: number; week?: string }>;
      edges: Array<{ from: string; to: string; type: string; order?: number }>;
      stats: { nodes: number; edges: number; byType: Record<string, number> };
    };
    expect(g.graphType).toBe('experimental');
    expect(g.stats.byType.experiment).toBe(1);
    expect(g.stats.byType.standard).toBe(2);
    expect(g.stats.byType.indicator).toBe(3);
    expect(g.stats.byType.step).toBe(5);
    expect(g.stats.nodes).toBe(g.nodes.length);
    expect(g.stats.edges).toBe(g.edges.length);
    // 操作链保序：step 节点 order 1..5；step→step 保序边 4 条（exp→step 另 5 条 step_order）
    const steps = g.nodes.filter((n) => n.type === 'step').sort((a, b) => a.order! - b.order!);
    expect(steps.map((s) => s.label)).toEqual(['站点布设', '采水', '现场固定', '仪器校准', '实验室测定']);
    const chain = g.edges.filter((e) => e.type === 'step_order' && e.from.startsWith('step-')).sort((a, b) => a.order! - b.order!);
    expect(chain).toHaveLength(4);
    // 关系类型齐全
    const types = new Set(g.edges.map((e) => e.type));
    for (const t of ['based_on', 'measures', 'uses', 'step_order', 'produces', 'has_qc', 'difficulty_of']) {
      expect(types.has(t)).toBe(true);
    }
  });

  it('fieldMap 自定义键名映射 + 字符串值按分隔符切分', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: {
        graphType: 'experimental',
        sections: [{
          id: 'E01',
          title: '土壤酶活测定',
          fields: { 依据文件: 'GB 9834-88、实验室 SOP-3', 测定参数: '脲酶活性' },
        }],
        fieldMap: { 依据文件: 'standard', 测定参数: 'indicator' },
      },
    });
    const g = r.data as { nodes: Array<{ type: string; label: string }> };
    const standards = g.nodes.filter((n) => n.type === 'standard').map((n) => n.label);
    expect(standards).toEqual(['GB 9834-88', '实验室 SOP-3']); // 顿号切分
    expect(g.nodes.some((n) => n.type === 'indicator' && n.label === '脲酶活性')).toBe(true);
  });

  it('缺 sections / 形态非法 → 结构化错误（INVALID_INPUT）', async () => {
    const adapter = new LocalAdapter();
    const missing = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { graphType: 'experimental' },
    });
    expect(missing.level).toBe('unavailable');
    expect(missing.errorCode).toBe('INVALID_INPUT');
    expect(missing.degradationNote).toContain('sections');
    const bad = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { graphType: 'experimental', sections: [{ title: '无字段' }] },
    });
    expect(bad.level).toBe('unavailable');
  });

  it('缺省 graphType 行为不变：conceptual 路径仍要求 structuredContent', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('extract_knowledge_graph', { inputs: {} });
    expect(r.level).toBe('unavailable');
    expect(r.degradationNote).toContain('structuredContent');
  });

  it('确定性：同输入两次调用输出一致', async () => {
    const adapter = new LocalAdapter();
    const a = await adapter.invokeSkill('extract_knowledge_graph', { inputs: EXPERIMENTAL_INPUT });
    const b = await adapter.invokeSkill('extract_knowledge_graph', { inputs: EXPERIMENTAL_INPUT });
    expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
  });
});
