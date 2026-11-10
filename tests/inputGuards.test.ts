import { describe, expect, it } from 'vitest';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import { handleMessage } from '../server/mcp.js';
import { extractKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import { fuseKnowledgeGraphs } from '../core/graph/fuseKnowledgeGraphs.js';
import { diffKnowledgeGraphs } from '../core/graph/diffKnowledgeGraphs.js';

const adapter = new LocalAdapter();

describe('extract_knowledge_graph 输入防御（六类坏输入）', () => {
  const cases: Array<[string, unknown]> = [
    ['structuredContent 缺失', {}],
    ['structuredContent 为 null', { structuredContent: null }],
    ['structuredContent 为空对象', { structuredContent: {} }],
    ['structuredContent 为字符串', { structuredContent: 'parse 输出' }],
    ['paragraphs 为字符串', { structuredContent: { paragraphs: 'x', structuredSections: [], knowledgePointCandidates: [] } }],
    ['knowledgePointCandidates 缺失', { structuredContent: { paragraphs: [], structuredSections: [] } }],
  ];
  for (const [name, inputs] of cases) {
    it(`${name} → 结构化中文错误（含引导），不抛异常`, async () => {
      const result = await adapter.invokeSkill('extract_knowledge_graph', { inputs: inputs as Record<string, unknown> });
      expect(result.level).toBe('unavailable');
      expect(result.degradationNote).toContain('输入校验失败');
      expect(result.degradationNote).toContain('parse_course_material');
    });
  }

  it('core 层直连坏输入返回 degraded 骨架而非抛异常', async () => {
    const r = await extractKnowledgeGraph({} as never);
    expect(r.level).toBe('degraded');
    const data = r.data as { entities: unknown[] };
    expect(data.entities).toEqual([]);
    expect(r.degradationNote).toContain('输入非法');
  });

  it('正常输入行为不变（端到端 golden 校验在 m1Loop 等既有用例）', async () => {
    const parsed = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: { content: '# 标题\n\n梯度下降是核心方法，梯度下降依赖学习率。', materialType: 'md' } },
    });
    const r = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { structuredContent: parsed.data },
    });
    expect(r.level).toBe('full');
    const okData = r.data as { entities: unknown[] };
    expect(okData.entities.length).toBeGreaterThan(0);
  });
});

describe('fuse / diff 输入防御', () => {
  it('fuse：graphs 缺失 / 非数组 → 结构化错误', async () => {
    const r1 = await adapter.invokeSkill('fuse_knowledge_graphs', { inputs: {} });
    expect(r1.level).toBe('unavailable');
    expect(r1.degradationNote).toContain('graphs');
    const r2 = await adapter.invokeSkill('fuse_knowledge_graphs', {
      inputs: { graphs: 'not-array', sources: [] },
    });
    expect(r2.level).toBe('unavailable');
    const core = await fuseKnowledgeGraphs({ graphs: 'x' as never, sources: [] });
    expect(core.level).toBe('unavailable');
  });

  it('diff：graphA/graphB 缺失或非法 → 结构化错误（core 同步守卫）', async () => {
    const r1 = await adapter.invokeSkill('diff_knowledge_graphs', { inputs: { graphA: {} } });
    expect(r1.level).toBe('unavailable');
    const core = await diffKnowledgeGraphs({ graphA: {} as never, graphB: null as never });
    expect(core.level).toBe('unavailable');
  });
});

describe('MCP 通道：坏输入返回协议级 isError 而非进程异常', () => {
  it('tools/call extract 坏输入 → isError=true 且文本含引导', async () => {
    const resp = await handleMessage(adapter, {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'extract_knowledge_graph', arguments: { structuredContent: {} } },
    });
    const result = resp!.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('parse_course_material');
    // 进程仍存活（handleMessage 正常返回即证明无异常逃逸）
    const ok = await handleMessage(adapter, {
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/list',
    });
    expect(ok!.result).toBeTruthy();
  });
});
