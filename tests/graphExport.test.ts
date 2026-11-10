import { describe, expect, it } from 'vitest';
import { toMermaid, toGraphml, toCsv, toJsonLd, exportGraph, MERMAID_MAX_NODES } from '../core/graph/graphExport.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

function graphFixture(): CourseKnowledgeGraph {
  return {
    schemaVersion: '1.2',
    entities: [
      { id: 'con-0', kind: 'concept', label: '种群密度', level: 0, order: 0, confidence: 0.9, source: { sectionOrder: [0], paragraphIndexes: [0, 1] } },
      { id: 'con-1', kind: 'concept', label: '标志重捕法', level: 0, order: 1, confidence: 0.7 },
    ],
    relations: [
      { id: 'edge-0', from: 'con-0', to: 'con-1', type: 'prerequisite', weight: 1, provenance: 'heuristic' },
      { id: 'edge-1', from: 'con-0', to: 'con-1', type: 'related', weight: 2, provenance: 'llm' },
    ],
    hierarchy: [],
    prerequisiteGraph: { nodes: ['con-0', 'con-1'], edges: [], topoOrder: ['con-0', 'con-1'] },
  };
}

describe('R5-3 图谱导出格式（反馈 b P1-5，确定性纯函数）', () => {
  it('mermaid：flowchart + 先修实线 + related 虚线', () => {
    const m = toMermaid(graphFixture());
    expect(m.startsWith('flowchart LR')).toBe(true);
    expect(m).toContain('-->');
    expect(m).toContain('-.->');
    expect(m).toMatch(/\[\"种群密度\"\]/);
  });

  it('mermaid 截断：>200 节点截断并注明', () => {
    const big: CourseKnowledgeGraph = {
      ...graphFixture(),
      entities: Array.from({ length: MERMAID_MAX_NODES + 10 }, (_, i) => ({
        id: `con-${i}`, kind: 'concept' as const, label: `概念${i}`, level: 0, order: i,
      })),
      relations: [],
    };
    const m = toMermaid(big);
    expect(m).toContain('截断');
    expect(m).toContain(`节点 ${MERMAID_MAX_NODES + 10} > ${MERMAID_MAX_NODES}`);
  });

  it('graphml：标准 XML 结构 + 节点/边数据', () => {
    const g = toGraphml(graphFixture());
    expect(g).toContain('<graphml xmlns="http://graphml.graphdrawing.org/xmlns">');
    expect(g).toContain('<node id="con-0">');
    expect(g).toContain('<data key="label">种群密度</data>');
    expect(g).toContain('<edge id="e0" source="con-0" target="con-1">');
    expect(g).toContain('edgedefault="directed"');
  });

  it('csv：entities+relations 两段，逗号转义', () => {
    const c = toCsv({
      ...graphFixture(),
      entities: [
        { id: 'con-0', kind: 'concept', label: '密度,含"引号"', level: 0, order: 0 },
        { id: 'con-1', kind: 'concept', label: '标志重捕法', level: 0, order: 1 },
      ],
    });
    expect(c).toContain('# entities.csv');
    expect(c).toContain('# relations.csv');
    expect(c).toContain('"密度,含""引号"""'); // RFC 4180 转义
    expect(c).toContain('edge-0,con-0,con-1,prerequisite,1,heuristic');
  });

  it('jsonld：@context + nodes/edges', () => {
    const d = JSON.parse(toJsonLd(graphFixture()));
    expect(d['@context']['@vocab']).toContain('nangying-starmap');
    expect(d.nodes).toHaveLength(2);
    expect(d.nodes[0]).toMatchObject({ '@id': 'con-0', label: '种群密度', confidence: 0.9 });
    expect(d.edges[1]).toMatchObject({ edgeType: 'related', provenance: 'llm' });
  });

  it('确定性：同图同串；exportGraph json → null', () => {
    expect(toMermaid(graphFixture())).toBe(toMermaid(graphFixture()));
    expect(toCsv(graphFixture())).toBe(toCsv(graphFixture()));
    expect(exportGraph(graphFixture(), 'json')).toBeNull();
  });

  it('端到端：outputFormat=mermaid 输出在 data.output，json 默认不变', async () => {
    const adapter = new LocalAdapter();
    const parsed = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: { content: '# 生态学\n\n种群密度是数量特征，种群密度决定方法。', materialType: 'md' } },
    });
    const graph = parsed.data as never;
    const r = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { structuredContent: graph, outputFormat: 'mermaid' },
    });
    const data = r.data as { output: string; format: string; entities: unknown[] };
    expect(data.format).toBe('mermaid');
    expect(data.output).toContain('flowchart');
    expect(data.entities.length).toBeGreaterThan(0); // 图谱本体仍在
    const def = await adapter.invokeSkill('extract_knowledge_graph', { inputs: { structuredContent: graph } });
    expect((def.data as { output?: string }).output).toBeUndefined();
  });
});
