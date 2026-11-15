/**
 * 解码器工厂：按 DecoderConfig.provider 构造内置供应商解码器。
 * 密钥由调用方在请求时刻经 keyProvider 惰性读取（不缓存、不打印）。
 */
import type { DecoderConfig, DocumentDecoder } from '../../../core/decode/documentDecoder.js';
import { createKimiDecoder } from './kimiDecoder.js';
import { createOpenAiVisionDecoder } from './openAiVisionDecoder.js';
import { createMineruDecoder } from '../../odlab/mineru.js';
import { createLocalOcrDecoder } from './localOcrDecoder.js';

export interface FactoryOptions {
  fetchImpl?: typeof fetch;
}

/** 解码器供应商全集（settings_card/CLI 的 provider 枚举与阶梯③跳过判定共用） */
export const KNOWN_DECODER_PROVIDERS = new Set([
  'kimi',
  'moonshot',
  'openai',
  'openai-vision',
  'vision',
  'mineru',
  'local-ocr',
  'localocr',
]);

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
    case 'local-ocr':
    case 'localocr':
      return createLocalOcrDecoder();
    default:
      throw new Error(`未知的解码器供应商："${config.provider}"（内置：kimi、openai、mineru、local-ocr）`);
  }
}

export { createKimiDecoder, createOpenAiVisionDecoder, createMineruDecoder };
export { redact } from './shared.js';
