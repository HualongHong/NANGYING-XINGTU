/**
 * 文档解码器契约（core/decode）——协议无关、纯 TS、零 Node API。
 *
 * 双重供给：
 *  1. 宿主注入：SkillContext.decoder（与 llm 并列的宿主注入点）；
 *  2. 用户配置：内置供应商解码器（adapters/core/decoders/），
 *     配置经适配层 configStore 读取，密钥走 secrets 惰性读取。
 *
 * 安全约定：DecoderConfig 类型层面不含任何密钥字段；
 * 密钥只在请求时刻由调用方经 keyProvider 读取，不进配置、不进日志。
 */

/** 解码产物：纯文本内容与归一化材料类型 */
export interface DecodedDocument {
  content: string;
  materialType: string;
  /** 解码说明（页数、OCR 置信度等，可选） */
  note?: string;
}

/** 解码器接口（宿主与内置供应商实现同一契约） */
export interface DocumentDecoder {
  decode(input: {
    data: Uint8Array;
    materialType: string;
    /** 可选：限定解码页区间（1 起，PDF 多页场景） */
    pageRange?: { from: number; to: number };
  }): Promise<DecodedDocument>;
}

/**
 * 解码器配置（非敏感）。类型层面禁止密钥字段——
 * 配置入参校验在适配层 configStore 再做一层运行时拦截。
 */
export interface DecoderConfig {
  provider: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  extra?: Record<string, string>;
}

/**
 * 二进制守卫：采样前 8KB，\x00 字节占比 > 1% 即视为二进制。
 * 纯函数、确定性；空输入视为文本。
 */
export function looksBinary(data: Uint8Array): boolean {
  const sample = data.subarray(0, 8192);
  if (sample.length === 0) return false;
  let nul = 0;
  for (const b of sample) {
    if (b === 0x00) nul += 1;
  }
  return nul / sample.length > 0.01;
}
