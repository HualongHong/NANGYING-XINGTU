/**
 * 对外消息密钥脱敏（适配层）。
 *
 * 背景：LLM/平台调用失败时，provider 错误体或异常 message 可能回显
 * Authorization 头、请求参数中的密钥；这些文本会经 degradationNote /
 * JSON-RPC error 流出到宿主与日志。本模块在 server 出口统一脱敏。
 *
 * 密钥来源：secrets.json 全部值 + 环境变量中名字含 KEY/TOKEN/SECRET/PASSWORD
 * 且值长 ≥8 的项。5 秒 TTL 缓存避免每次响应都读盘。
 */
import { listSecretValues } from './configStore.js';

const MIN_SECRET_LEN = 8;
const CACHE_TTL_MS = 5000;

let cache: { at: number; values: string[] } | null = null;

/** 已知密钥值清单（长的在前，避免短串先替换破坏长串匹配） */
export function knownSecretValues(): string[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.values;
  const values = new Set<string>();
  for (const v of listSecretValues()) {
    if (v.length >= MIN_SECRET_LEN) values.add(v);
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (/key|token|secret|password/i.test(k) && typeof v === 'string' && v.length >= MIN_SECRET_LEN) {
      values.add(v);
    }
  }
  cache = { at: now, values: [...values].sort((a, b) => b.length - a.length) };
  return cache.values;
}

/** 文本脱敏：出现的已知密钥值替换为 *** */
export function redactSecrets(text: string): string {
  let out = text;
  for (const s of knownSecretValues()) {
    if (out.includes(s)) out = out.split(s).join('***');
  }
  return out;
}

/** 深度脱敏：递归处理对象/数组中的全部字符串（用于 SkillResult 等出口对象） */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as T;
  }
  return value;
}

/** 测试用：清空 TTL 缓存（写完 secrets 后立即断言） */
export function resetRedactCache(): void {
  cache = null;
}
