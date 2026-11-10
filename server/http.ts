/**
 * HTTP JSON-RPC 入口：Node 原生 http，POST /rpc。
 * 与 MCP 层共用 handleMessage（同一 JSON-RPC handler）。
 */
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { AdapterBase } from '../adapters/core/adapter.base.js';
import { handleMessage } from './mcp.js';

/** 启动 HTTP JSON-RPC server；返回 Server 实例（测试用，需自行 close） */
export function startHttpServer(adapter: AdapterBase, port = 0, host = '127.0.0.1'): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '仅支持 POST /rpc' }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      void (async () => {
        let msg: Parameters<typeof handleMessage>[1];
        try {
          msg = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0', id: null,
            error: { code: -32700, message: '解析错误' },
          }));
          return;
        }
        const resp = await handleMessage(adapter, msg);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(resp ?? { jsonrpc: '2.0', id: msg.id, result: null }));
      })();
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

// 直接运行入口：node dist/server/http.js
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { LocalAdapter } = await import('../adapters/core/local.adapter.js');
  const port = Number(process.env.PORT ?? 7379);
  void startHttpServer(new LocalAdapter({ envLlm: process.env.NANGYING_MCP_LLM === '1' }), port).then((s) => {
    const addr = s.address();
    console.log(`nangying-starmap HTTP JSON-RPC 已启动：http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}/rpc`);
  });
}
