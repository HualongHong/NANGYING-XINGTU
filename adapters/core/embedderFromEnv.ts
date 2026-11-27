/**
 * 从 .env / settings(extra.embeddings) / secrets 构造 EmbedderProvider（OpenAI 兼容 /embeddings）。
 * KAG-1 R24：KB 向量召回的可选增强——baseUrl+model 齐备才构造，key 可选（本地端点如 ollama 免密）；
 * 不齐备返回 undefined（调用方纯倒排降级，主流程不受影响）。
 *
 * 解析顺序：.env NANGYING_EMBEDDINGS_* → settings.json extra.embeddings（settings_card 写入）
 * → secrets.json 命名密钥 embeddingsApiKey。密钥惰性读取、错误响应经 *** 脱敏、绝不打印 key。
 */
import type { EmbedderProvider } from '../../core/llm.js';
import { loadDotEnv, loadProjectDotEnv } from './dotenv.js';
import { readConfig, readApiKey } from './configStore.js';

/** 端点归一：缺 embeddings 路径时自动补（/vN → +/embeddings，否则 +/v1/embeddings） */
export function resolveEmbeddingsEndpoint(raw: string): string {
  let e = raw.replace(/\/$/, '');
  if (!/\/embeddings$/.test(e)) {
    e = /\/v\d$/.test(e) ? `${e}/embeddings` : `${e}/v1/embeddings`;
  }
  return e;
}

export function createEmbedderFromEnv(opts: { dotEnvPath?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): EmbedderProvider | undefined {
  const env = opts.dotEnvPath ? loadDotEnv(opts.dotEnvPath) : loadProjectDotEnv();
  let cfg: Record<string, string> = {};
  try {
    cfg = JSON.parse(readConfig()?.extra?.embeddings ?? '{}') as Record<string, string>;
  } catch {
    cfg = {};
  }
  const baseUrl = env.NANGYING_EMBEDDINGS_BASE_URL ?? cfg.baseUrl;
  const model = env.NANGYING_EMBEDDINGS_MODEL ?? cfg.model;
  const apiKey = env.NANGYING_EMBEDDINGS_API_KEY ?? readApiKey('embeddingsApiKey');
  if (!baseUrl || !model) return undefined;
  const endpoint = resolveEmbeddingsEndpoint(baseUrl);
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return {
    model,
    async embed(texts: string[]): Promise<number[][]> {
      const res = await f(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`embeddings 端点 HTTP ${res.status}：${apiKey ? body.replaceAll(apiKey, '***') : body}`);
      }
      const payload = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
      const items = payload.data ?? [];
      if (items.length !== texts.length) {
        throw new Error(`embeddings 返回数量不符：期望 ${texts.length}，实得 ${items.length}`);
      }
      return items
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => {
          if (!Array.isArray(d.embedding) || d.embedding.length === 0) {
            throw new Error('embeddings 返回缺 embedding 字段或为空向量');
          }
          return d.embedding;
        });
    },
  };
}
