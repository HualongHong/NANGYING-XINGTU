/**
 * 解码器工厂：按 DecoderConfig.provider 构造内置供应商解码器。
 * 密钥由调用方在请求时刻经 keyProvider 惰性读取（不缓存、不打印）。
 */
import type { DecoderConfig, DocumentDecoder } from '../../../core/decode/documentDecoder.js';
import { createKimiDecoder } from './kimiDecoder.js';
import { createOpenAiVisionDecoder } from './openAiVisionDecoder.js';
import { createMineruDecoder } from '../../odlab/mineru.js';

export interface FactoryOptions {
  fetchImpl?: typeof fetch;
}

export function createDecoder(
  config: DecoderConfig,
  keyProvider: () => string | undefined,
  opts: FactoryOptions = {},
): DocumentDecoder {
  const provider = config.provider.trim().toLowerCase();
  switch (provider) {
    case 'kimi':
    case 'moonshot':
      return createKimiDecoder({ config, keyProvider, fetchImpl: opts.fetchImpl });
    case 'openai':
    case 'openai-vision':
    case 'vision':
      return createOpenAiVisionDecoder({ config, keyProvider, fetchImpl: opts.fetchImpl });
    case 'mineru':
      return createMineruDecoder({ config, keyProvider, fetchImpl: opts.fetchImpl });
    default:
      throw new Error(`未知的解码器供应商："${config.provider}"（内置：kimi、openai、mineru）`);
  }
}

export { createKimiDecoder, createOpenAiVisionDecoder, createMineruDecoder };
export { redact } from './shared.js';
