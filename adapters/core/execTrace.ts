/**
 * 执行轨迹（适配层）：教师工作台与效率度量的数据源。
 *
 * 每次 invokeSkill 落一条 JSONL：configDir()/traces/YYYY-MM.jsonl（按月分文件）。
 * 字段含技能、结果等级、耗时、平台；error 字段截断并脱敏（落盘数据不出密钥）。
 * 写盘失败静默吞掉——轨迹绝不影响技能执行本身。
 * env NANGYING_TRACE=0 可整体关闭。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './configStore.js';
import { redactSecrets } from './redact.js';

export interface ExecTraceEntry {
  /** ISO 时间戳 */
  ts: string;
  skill: string;
  /** level !== 'unavailable' 且未抛异常 */
  ok: boolean;
  /** full | degraded | unavailable | error（执行器抛异常） */
  level: string;
  durationMs: number;
  platform?: string;
  /** 错误摘要（≤200 字符，已脱敏） */
  error?: string;
}

export function tracesDir(): string {
  return join(configDir(), 'traces');
}

function traceEnabled(): boolean {
  if (process.env.NANGYING_TRACE === '1') return true;
  if (process.env.NANGYING_TRACE === '0') return false;
  // 测试进程默认关闭（避免污染真实 configDir）；测试可用 NANGYING_TRACE=1 显式打开
  return !process.env.VITEST;
}

function monthFile(d: Date): string {
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return join(tracesDir(), `${ym}.jsonl`);
}

/** 追加一条轨迹（任何异常静默吞掉） */
export function appendTrace(entry: ExecTraceEntry): void {
  if (!traceEnabled()) return;
  try {
    mkdirSync(tracesDir(), { recursive: true });
    appendFileSync(monthFile(new Date()), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // 轨迹失败不影响主流程
  }
}

/** 便捷构造：错误摘要截断 + 脱敏 */
export function traceError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg).slice(0, 200);
}

/**
 * 读取近 N 天轨迹（默认 30 天），按时间升序。
 * 坏行跳过；文件缺失返回空。limit 截断保留最新。
 */
export function readTraces(opts: { days?: number; limit?: number } = {}): ExecTraceEntry[] {
  const days = opts.days ?? 30;
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  const dir = tracesDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
    .sort();
  const out: ExecTraceEntry[] = [];
  for (const f of files) {
    let lines: string[];
    try {
      lines = readFileSync(join(dir, f), 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as ExecTraceEntry;
        if (typeof e.ts !== 'string' || typeof e.skill !== 'string') continue;
        if (Date.parse(e.ts) < cutoff) continue;
        out.push(e);
      } catch {
        // 跳过坏行
      }
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (opts.limit && out.length > opts.limit) return out.slice(out.length - opts.limit);
  return out;
}
