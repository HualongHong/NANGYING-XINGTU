/**
 * 从 .env / secrets.json 构造宿主 LLMProvider（OpenAI 兼容 chat/completions）。
 * 让"用户只填仓库根 .env 即可用"成为正式能力（非脚本特例）。
 *
 * 密钥解析顺序：provider→环境变量映射（.env 文件内）→ secrets.json。
 * 仅读 .env 文件与 secrets，不看进程环境变量（避免单元测试被宿主环境意外触发真实请求）。
 * 密钥惰性读取、错误响应经 *** 脱敏、绝不打印 key。
 */
import type { LLMProvider } from '../../core/llm.js';
import { loadDotEnv, loadProjectDotEnv } from './dotenv.js';
import { readConfig, readApiKey } from './configStore.js';

const ENV_KEY_MAP: Record<string, string> = {
  minimax: 'MINIMAX_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
};

const DEFAULT_MODEL: Record<string, string> = {
  minimax: 'MiniMax-M3',
  deepseek: 'deepseek-flash',
  kimi: 'moonshot-v1-8k',
  moonshot: 'moonshot-v1-8k',
};

/** 端点归一：缺 chat/completions 路径时自动补（/vN → +/chat/completions，否则 +/v1/chat/completions） */
const DEFAULT_ENDPOINT: Record<string, string> = {
  minimax: 'https://api.minimaxi.com/v1',
  deepseek: 'https://api.deepseek.com',
  kimi: 'https://api.moonshot.cn/v1',
  moonshot: 'https://api.moonshot.cn/v1',
};

export function resolveChatEndpoint(raw: string | undefined, provider: string): string {
  let e = (raw ?? '').replace(/\/$/, '');
  if (!e) {
    e = DEFAULT_ENDPOINT[provider] ?? 'https://api.openai.com/v1';
  }
  if (!/\/chat\/completions$/.test(e)) {
    e = /\/v\d$/.test(e) ? `${e}/chat/completions` : `${e}/v1/chat/completions`;
  }
  return e;
}

/**
 * 从 .env / secrets 构造 LLMProvider；无可用密钥返回 undefined（调用方走无 LLM 路径）。
 * 可通过 dotEnvPath 注入 .env 路径（测试用临时文件，不触碰真实 .env）。
 */
export function createLlmFromEnv(opts: { dotEnvPath?: string; fetchImpl?: typeof fetch } = {}): LLMProvider | undefined {
  const env = opts.dotEnvPath ? loadDotEnv(opts.dotEnvPath) : loadProjectDotEnv();
  const config = readConfig() ?? { provider: '' };
  // provider 未配置时，从 .env 中实际存在的密钥反推提供商
  let provider = (env.NANGYING_LLM_PROVIDER ?? config.provider ?? '').toLowerCase();
  if (!provider || !ENV_KEY_MAP[provider]) {
    const hit = Object.entries(ENV_KEY_MAP).find(([, v]) => Boolean(env[v]));
    if (hit) provider = hit[0];
  }

  let apiKey: string | undefined;
  if (ENV_KEY_MAP[provider]) apiKey = env[ENV_KEY_MAP[provider]];
  if (!apiKey) apiKey = readApiKey();
  if (!apiKey) return undefined;

  const endpoint = resolveChatEndpoint(env.NANGYING_LLM_ENDPOINT ?? config.endpoint, provider);
  const model = env.NANGYING_LLM_MODEL ?? config.model ?? DEFAULT_MODEL[provider] ?? 'gpt-4o';
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async complete(prompt: string, options?: { signal?: AbortSignal } & Record<string, unknown>): Promise<string> {
      // 挂起请求兜底：2 分钟 AbortSignal 超时（ MCP 超时通道防数十批同步调用卡死）
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      const onAbort = () => controller.abort();
      if (options?.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }
      let resp: Response;
      try {
        resp = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              { role: 'system', content: '你是生物化学实验课程的术语判定助手，只输出 JSON。' },
              { role: 'user', content: prompt },
            ],
          }),
        });
      } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
      }
      const raw = await resp.text().catch(() => '');
      if (!resp.ok) {
        const safe = raw.split(apiKey as string).join('***');
        throw new Error(`LLM 请求失败 HTTP ${resp.status}：${safe.slice(0, 200)}`);
      }
      const content = (JSON.parse(raw) as {
        choices?: Array<{ message?: { content?: string } }>;
      }).choices?.[0]?.message?.content ?? '';
      return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    },
  };
}
