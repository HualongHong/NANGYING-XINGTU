/**
 * 错误脱敏与解码器公共工具（适配层）。
 * 任何进入错误信息/日志的文本，如出现密钥子串则替换为 ***。
 */

/** 若 text 含 key 子串则替换为 ***（key 为空/过短时原样返回，避免误伤） */
export function redact(text: string, key: string | undefined): string {
  if (!key || key.length < 4) return text;
  return text.split(key).join('***');
}

/** 构造带超时的 AbortController 信号 */
export function withTimeout(timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), timeoutMs).unref?.();
  return ctrl.signal;
}
