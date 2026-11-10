/**
 * OpenAI 兼容 chat/completions 视觉解码器：图片 base64 进 messages，
 * prompt 要求逐页转录文本。适用于扫描版 PDF/图片型 PPT 的 OCR 式转录。
 * endpoint 默认 https://api.openai.com/v1，模型默认 gpt-4o，均可配。
 */
import type { DecoderConfig, DecodedDocument, DocumentDecoder } from '../../../core/decode/documentDecoder.js';
import { redact, withTimeout } from './shared.js';

export interface OpenAiVisionDecoderOptions {
  config: DecoderConfig;
  keyProvider: () => string | undefined;
  fetchImpl?: typeof fetch;
}

const IMAGE_TYPES = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif']);

export function createOpenAiVisionDecoder(opts: OpenAiVisionDecoderOptions): DocumentDecoder {
  const { config, keyProvider } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = (config.endpoint ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = config.model ?? 'gpt-4o';
  const timeoutMs = config.timeoutMs ?? 120_000;

  return {
    async decode(input: { data: Uint8Array; materialType: string }): Promise<DecodedDocument> {
      const key = keyProvider();
      if (!key) throw new Error('未配置 API key：请运行配置向导或注入宿主解码器');
      const mime = IMAGE_TYPES.has(input.materialType) ? 'application/pdf' : 'image/png';
      const base64 = Buffer.from(input.data).toString('base64');
      const body = JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '请逐页转录这份课程文档中的全部文字内容，保持原有章节顺序，直接输出转录文本。',
              },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
            ],
          },
        ],
      });
      let resp: Response;
      try {
        resp = await fetchImpl(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: withTimeout(timeoutMs),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`视觉解码请求失败：${redact(msg, key)}`);
      }
      const raw = await resp.text().catch(() => '');
      if (!resp.ok) {
        throw new Error(`视觉解码失败（HTTP ${resp.status}）：${redact(raw.slice(0, 300), key)}`);
      }
      let parsed: { choices?: Array<{ message?: { content?: unknown } }> };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        throw new Error(`视觉解码响应非法：${redact(raw.slice(0, 300), key)}`);
      }
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content) {
        throw new Error('视觉解码响应缺少文本内容');
      }
      return { content, materialType: input.materialType, note: `${model} 视觉转录` };
    },
  };
}
