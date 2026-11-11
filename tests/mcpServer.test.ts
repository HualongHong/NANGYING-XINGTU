import { describe, expect, it, afterAll } from 'vitest';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import { handleMessage } from '../server/mcp.js';
import { startHttpServer } from '../server/http.js';
import type { Server } from 'node:http';

const adapter = new LocalAdapter();

describe('MCP handleMessage', () => {
  it('initialize 返回协议与服务器信息', async () => {
    const resp = await handleMessage(adapter, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });
    expect(resp!.id).toBe(1);
    const result = resp!.result as { serverInfo: { name: string } };
    expect(result.serverInfo.name).toBe('nangying-starmap');
  });

  it('tools/list 列出全部 31 个已实现技能', async () => {
    const resp = await handleMessage(adapter, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const tools = (resp!.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      'parse_course_material',
      'extract_knowledge_graph',
      'fuse_knowledge_graphs',
      'diff_knowledge_graphs',
      'design_course_structure',
      'generate_teaching_script',
      'translate_multilingual',
      'build_qa_knowledge_base',
      'recommend_learning_path',
      'generate_personalized_feedback',
      'manage_course_assets',
      'export_course_package',
      'register_teacher_avatar',
      'synthesize_speech',
      'generate_digital_human_video',
      'orchestrate_multi_teacher',
      'match_teaching_scene',
      'sync_multilingual_av',
      'realtime_qa_stream',
      'manage_async_tasks',
      'describe_capabilities',
      'generate_assessment',
      'audit_consistency',
      'polish_teaching_text',
      'sync_bilingual',
      'qa_media',
      'render_preview',
      'build_industry_graph',
      'link_knowledge_industry',
      'submit_feedback',
      'settings_card',
    ]);
  });

  it('tools/list 的 inputSchema 是真实类型（oneOf string/object + required + 别名透出）', async () => {
    const resp = await handleMessage(adapter, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/list',
    });
    const tools = (resp!.result as {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: {
          type: string;
          required: string[];
          properties: Record<string, { type?: string; oneOf?: Array<{ type: string }>; description?: string }>;
        };
      }>;
    }).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));

    // 契约真名 + required 语义（反馈 P0-1/P0-6）
    const design = byName.get('design_course_structure')!;
    expect(design.inputSchema.required).toEqual(['graph', 'objectives']);
    const graphProp = design.inputSchema.properties.graph;
    expect(graphProp.oneOf?.map((s) => s.type)).toEqual(['string', 'object']); // oneOf string/object（反馈 P0-2）
    expect(graphProp.description).toContain('knowledgeGraph'); // 别名透出进 schema
    expect(design.inputSchema.properties.objectives.description).toContain('teachingObjectives');

    // async 可选参数透出（反馈 P0-5）
    const parse = byName.get('parse_course_material')!;
    expect(parse.inputSchema.required).toEqual(['materialFile']);
    expect(parse.inputSchema.properties.async?.type).toBe('boolean');
    expect(parse.inputSchema.properties.workspaceRoot?.type).toBe('string');
    expect(parse.inputSchema.properties.materialFile.description).toContain('文件路径字符串');

    // 数组类型 + 字符串双形态
    const fuse = byName.get('fuse_knowledge_graphs')!;
    expect(fuse.inputSchema.properties.graphs.oneOf?.map((s) => s.type)).toEqual(['string', 'array']);
    expect(fuse.inputSchema.properties.sources.description).toContain('必填');

    // 上游技能与用法透出（P1-2 可发现性）
    expect(design.description).toContain('用法：');
    expect(design.inputSchema.properties.graph.description).toContain('extract_knowledge_graph');
  });

  it('tools/call 调用 parse 技能', async () => {
    const resp = await handleMessage(adapter, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'parse_course_material',
        arguments: { materialFile: 'tests/fixtures/sample-lecture-ml-basics.md' },
      },
    });
    const result = resp!.result as {
      content: Array<{ text: string }>;
      isError: boolean;
      structuredContent?: unknown;
    };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.level).toBe('full');
    expect(payload.data.paragraphs.length).toBeGreaterThan(15);
    // R8-2：structuredContent 通道与文本通道一致（免二次 JSON.parse）
    expect(result.structuredContent).toEqual(payload);
  });

  it('tools/call 未知技能回 isError', async () => {
    const resp = await handleMessage(adapter, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    const result = resp!.result as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it('未知方法回 JSON-RPC error', async () => {
    const resp = await handleMessage(adapter, {
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/read',
    });
    expect(resp!.error!.code).toBe(-32601);
    expect(resp!.error!.message).toContain('不支持的方法');
  });

  it('通知类消息（无 id）不应答', async () => {
    const resp = await handleMessage(adapter, {
      jsonrpc: '2.0',
      id: undefined as never,
      method: 'notifications/initialized',
    });
    expect(resp).toBeNull();
  });
});

describe('HTTP JSON-RPC 入口', () => {
  let server: Server;
  let port: number;

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('POST /rpc 走同一 handler', async () => {
    server = await startHttpServer(adapter, 0);
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;

    const resp = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize' }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.result.serverInfo.name).toBe('nangying-starmap');

    // tools/call 经 HTTP 全链路
    const resp2 = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'parse_course_material',
          arguments: { materialFile: { content: '# 标题\n\n内容。', materialType: 'md' } },
        },
      }),
    });
    const body2 = await resp2.json();
    const payload = JSON.parse(body2.result.content[0].text);
    expect(payload.data.structuredSections[0].title).toBe('标题');

    // 非 POST /rpc 返回 404
    const resp3 = await fetch(`http://127.0.0.1:${port}/other`, { method: 'GET' });
    expect(resp3.status).toBe(404);
  }, 15000);
});
