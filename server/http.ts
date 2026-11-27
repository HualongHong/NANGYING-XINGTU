/**
 * HTTP JSON-RPC 入口：Node 原生 http，POST /rpc。
 * 与 MCP 层共用 handleMessage（同一 JSON-RPC handler）。
 */
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { AdapterBase } from '../adapters/core/adapter.base.js';
import { handleMessage } from './mcp.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** 启动 HTTP JSON-RPC server；返回 Server 实例（测试用，需自行 close） */
export function startHttpServer(adapter: AdapterBase, port = 0, host = '127.0.0.1'): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '仅支持 POST /rpc' }));
      return;
    }
    let body = '';
    let bodyBytes = 0;
    let responded = false;
    const respond = (status: number, payload: unknown) => {
      if (responded || res.writableEnded) return;
      const responseBody = JSON.stringify(payload);
      responded = true;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(responseBody);
    };
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      respond(413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: '请求体超过 10 MiB 上限' } });
      req.resume();
      return;
    }
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (responded) return;
      bodyBytes += Buffer.byteLength(chunk);
      if (bodyBytes > MAX_BODY_BYTES) {
        respond(413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: '请求体超过 10 MiB 上限' } });
        return;
      }
      body += chunk;
    });
    req.on('error', () => {
      respond(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: '请求读取失败' } });
    });
    req.on('end', () => {
      if (responded) return;
      let msg: Parameters<typeof handleMessage>[1];
      try {
        msg = JSON.parse(body);
      } catch {
        respond(400, {
          jsonrpc: '2.0', id: null,
          error: { code: -32700, message: '解析错误' },
        });
        return;
      }
      void handleMessage(adapter, msg).then((resp) => {
        if (resp === null) {
          if (responded || res.writableEnded) return;
          responded = true;
          res.writeHead(204);
          res.end();
          return;
        }
        respond(200, resp);
      }).catch((err: unknown) => {
        respond(500, {
          jsonrpc: '2.0', id: msg.id ?? null,
          error: { code: -32603, message: `服务处理失败：${err instanceof Error ? err.message : String(err)}` },
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

// 直接运行入口：node dist/server/http.js
// 端口优先级：环境变量 PORT > settings_card 写入的 settings.json extra.port > 默认 7379
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { LocalAdapter } = await import('../adapters/core/local.adapter.js');
  const { readConfig } = await import('../adapters/core/configStore.js');
  const storedPort = readConfig()?.extra?.port;
  const port = Number(process.env.PORT ?? storedPort ?? 7379);
  void startHttpServer(new LocalAdapter({ envLlm: process.env.NANGYING_MCP_LLM === '1', envEmbeddings: process.env.NANGYING_MCP_EMBEDDINGS === '1' }), port).then((s) => {
    const addr = s.address();
    console.log(`nangying-starmap HTTP JSON-RPC 已启动：http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}/rpc`);
  });
}
