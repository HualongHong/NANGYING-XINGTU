/**
 * Kimi（Moonshot）文件解析解码器：POST 文件内容，取回解析文本。
 * endpoint 默认 https://api.moonshot.cn，模型/路径经 DecoderConfig 可配。
 */
import type { DecoderConfig, DecodedDocument, DocumentDecoder } from '../../../core/decode/documentDecoder.js';
import { redact, withTimeout } from './shared.js';

export interface KimiDecoderOptions {
  config: DecoderConfig;
  /** 请求时刻惰性读取密钥；不缓存、不打印 */
  keyProvider: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export function createKimiDecoder(opts: KimiDecoderOptions): DocumentDecoder {
  const { config, keyProvider } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = (config.endpoint ?? 'https://api.moonshot.cn').replace(/\/$/, '');
  const model = config.model ?? 'moonshot-v1-8k';
  const timeoutMs = config.timeoutMs ?? 60_000;

  return {
    async decode(input: { data: Uint8Array; materialType: string }): Promise<DecodedDocument> {
      const key = keyProvider();
      if (!key) throw new Error('未配置 API key：请运行配置向导或注入宿主解码器');
      const form = new FormData();
      form.append('model', model);
      form.append('file', new Blob([input.data as BlobPart]), `document.${input.materialType}`);
      let resp: Response;
      try {
        resp = await fetchImpl(`${endpoint}/v1/files/extract`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal: withTimeout(timeoutMs),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Kimi 解码请求失败：${redact(msg, key)}`);
      }
      const raw = await resp.text().catch(() => '');
      if (!resp.ok) {
        throw new Error(`Kimi 解码失败（HTTP ${resp.status}）：${redact(raw.slice(0, 300), key)}`);
      }
      let parsed: { content?: unknown; text?: unknown };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        throw new Error(`Kimi 解码响应非法：${redact(raw.slice(0, 300), key)}`);
      }
      const content = typeof parsed.content === 'string' ? parsed.content
        : typeof parsed.text === 'string' ? parsed.text : '';
      if (!content) throw new Error('Kimi 解码响应缺少文本内容');
      return { content, materialType: input.materialType, note: `Kimi ${model} 解析` };
    },
  };
}
