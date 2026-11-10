/**
 * MCP 最小兼容 server：stdio 传输，换行分隔 JSON-RPC 2.0。
 * 不依赖 @modelcontextprotocol/sdk。
 *
 * 实现范围：initialize / tools/list / tools/call；
 * 其余方法返回 JSON-RPC error（-32601 Method not found）。
 * handleMessage 为纯函数便于测试；startMcpServer 接线 stdio。
 */
import type { AdapterBase } from '../adapters/core/adapter.base.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import manifest from '../manifests/plugin.manifest.json' with { type: 'json' };
import { pathToFileURL } from 'node:url';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** 处理单条 JSON-RPC 消息，返回响应对象（通知类消息返回 null） */
export async function handleMessage(
  adapter: AdapterBase,
  msg: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: msg?.id ?? null,
      error: { code: INVALID_PARAMS, message: '非法 JSON-RPC 请求' },
    };
  }
  if (msg.id === undefined || msg.id === null) {
    return null; // 通知：不应答
  }

  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: manifest.id, version: manifest.version },
        },
      };

    case 'tools/list': {
      // 通过空输入调用获取已注册技能清单：借用 invokeSkill 的注册表
      const tools = listRegisteredSkills(adapter).map((d) => {
        const specs = d.inputSpecs ?? d.inputs.map((name) => ({
          name, kind: 'string' as const, required: (d.required ?? d.inputs).includes(name),
          hint: undefined as string | undefined, aliases: undefined as string[] | undefined, producer: undefined as string[] | undefined,
        }));
        const properties: Record<string, unknown> = {};
        for (const spec of specs) {
          const notes = [
            spec.hint,
            spec.aliases && spec.aliases.length > 0 ? `兼容别名：${spec.aliases.join('、')}（自动归一化）` : '',
            spec.producer && spec.producer.length > 0 ? `上游技能：${spec.producer.join(' → ')}` : '',
            spec.required ? '必填' : '可选',
          ].filter(Boolean).join('；');
          // 对象/数组入参同时接受 JSON 字符串（执行器自动 parse）与真实结构
          const typeSchema =
            spec.kind === 'object' ? { oneOf: [{ type: 'string', description: 'JSON 字符串（执行器自动解析）' }, { type: 'object' }] }
            : spec.kind === 'array' ? { oneOf: [{ type: 'string', description: 'JSON 字符串（执行器自动解析）' }, { type: 'array' }] }
            : spec.kind === 'number' ? { type: 'number' }
            : spec.kind === 'boolean' ? { type: 'boolean' }
            : spec.kind === 'string' ? { type: 'string' }
            : {};
          properties[spec.name] = { ...typeSchema, description: notes || `输入：${spec.name}` };
        }
        return {
          name: d.skillId,
          description: `${d.name}：${d.description}` +
            (d.usage ? `（用法：${d.usage}）` : '') +
            `（降级策略：${d.degradation}）` +
            (d.skillId === 'parse_course_material'
              ? '。时长指引：大材料（>5 万字）在启用 LLM 过滤时可能超过 10 分钟（批并发执行 + 总预算兜底，进度经 progress 通知回报）；建议大材料加 async:true 提交后用 manage_async_tasks 轮询（不受宿主超时限制），或先跑启发式（不注入 LLM）'
              : ''),
          inputSchema: {
            type: 'object',
            properties,
            required: d.required ?? [],
          },
        };
      });
      return { jsonrpc: '2.0', id: msg.id, result: { tools } };
    }

    case 'tools/call': {
      const params = msg.params ?? {};
      const name = params.name as string | undefined;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!name) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: INVALID_PARAMS, message: 'tools/call 缺少 name 参数' },
        };
      }
      try {
        // 进度回报：tools/call 带 progressToken 时，每批 LLM 过滤发 progress 通知 + stderr
        const progressToken = (params as { progressToken?: unknown }).progressToken;
        const onProgress = progressToken === undefined ? undefined
          : (done: number, total: number, message: string) => {
              process.stderr.write(String.fromCharCode(10).length ? `[nangying-starmap] ${message}` + String.fromCharCode(10) : '');
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken, progress: done, total, message },
              }) + String.fromCharCode(10));
            };
        const result = await adapter.invokeSkill(name, { inputs: args, onProgress });
        const text = JSON.stringify(result, null, 2);
        // R8-2（反馈 b P1-5）：同时带 structuredContent（MCP 标准字段），调用方免二次 JSON.parse；
        // 结果不是 JSON 对象时不回 structuredContent（保持纯文本通道）
        let structuredContent: unknown;
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed === 'object' && parsed !== null) structuredContent = parsed;
        } catch {
          structuredContent = undefined;
        }
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text }],
            isError: result.level === 'unavailable',
            ...(structuredContent !== undefined ? { structuredContent } : {}),
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: INTERNAL_ERROR,
            message: `技能调用失败：${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    }

    default:
      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: METHOD_NOT_FOUND, message: `不支持的方法：${msg.method}` },
      };
  }
}

/** 列出适配器已注册技能描述符 */
function listRegisteredSkills(adapter: AdapterBase): SkillDescriptorLike[] {
  return adapter.listSkills();
}

interface SkillDescriptorLike {
  skillId: string;
  name: string;
  description: string;
  inputs: string[];
  required?: string[];
  degradation: string;
  usage?: string;
  inputSpecs?: Array<{
    name: string;
    kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'any';
    required: boolean;
    aliases?: string[];
    hint?: string;
    producer?: string[];
  }>;
}

/** 启动 MCP server：stdio 换行分隔 JSON-RPC，逐行处理 */
export function startMcpServer(adapter: AdapterBase): void {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(line) as JsonRpcRequest;
      } catch {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: '解析错误' },
          }) + '\n',
        );
        continue;
      }
      void handleMessage(adapter, msg).then((resp) => {
        if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
      });
    }
  });
}

/** server 通道适配器：宿主不注入时默认走启发式（env NANGYING_MCP_LLM=1 才回退 .env LLM） */
export function createMcpAdapter() {
  return new LocalAdapter({ envLlm: process.env.NANGYING_MCP_LLM === '1' });
}

// 直接运行入口：node dist/server/mcp.js
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startMcpServer(createMcpAdapter());
}
