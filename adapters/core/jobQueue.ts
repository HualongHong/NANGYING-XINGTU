/**
 * 作业注册表（适配层，Node API）：异步任务的提交/轮询/取消/磁盘快照。
 *
 * - 同进程后台执行，不阻塞 stdio；MCP server 被宿主重启后，
 *   磁盘快照可恢复 done/error/cancelled 结果（running 标记 interrupted）；
 * - cancel 经 AbortController 贯通：正在飞的 LLM 批自然落地后标记 cancelled；
 * - 完成结果保留 24 小时（加载/查询/清理时惰性清理过期快照）；
 * - 耗时分段计时（accumulatedMs + resumedAtMs）：终态冻结，重启/重读绝不重复累计
 *   （修 interrupted 任务 3,416,899ms 异常值）；
 * - cleanupJobs：清理超龄终态作业，顺带规范化遗留 running 快照（elapsedMs 冻结持久化）。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './configStore.js';

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';

export interface JobProgress {
  done: number;
  total: number;
  message: string;
}

export interface JobSnapshot {
  jobId: string;
  skill: string;
  label?: string;
  status: JobStatus;
  progress?: JobProgress;
  /** 作业产出（SkillResult 对象） */
  result?: unknown;
  error?: string;
  submittedAt: string;
  updatedAt: string;
  elapsedMs?: number;
  /** 分段计时：已累积的运行毫秒（终态冻结；server 重启不重复累计） */
  accumulatedMs?: number;
  /** 分段计时：当前段起始时刻（epoch ms；终态时删除） */
  resumedAtMs?: number;
}

export interface JobHandle {
  jobId: string;
  status: JobStatus;
}

const RETENTION_MS = 24 * 60 * 60_000;

const memory = new Map<string, { snapshot: JobSnapshot; controller: AbortController }>();

function jobsDir(): string {
  return join(configDir(), 'cache', 'jobs');
}

function jobFile(jobId: string): string {
  return join(jobsDir(), `${jobId}.json`);
}

function persist(snapshot: JobSnapshot): void {
  try {
    mkdirSync(jobsDir(), { recursive: true });
    const tmp = `${jobFile(snapshot.jobId)}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    renameSync(tmp, jobFile(snapshot.jobId));
  } catch {
    // 磁盘不可写时仅保留内存态（不中断作业）
  }
}

function touch(snapshot: JobSnapshot): void {
  snapshot.updatedAt = new Date().toISOString();
  const entry = memory.get(snapshot.jobId);
  if (entry) entry.snapshot = snapshot;
  persist(snapshot);
}

/** 清理过期快照（提交/查询/清理时惰性调用） */
function purgeExpired(): void {
  try {
    if (!existsSync(jobsDir())) return;
    for (const f of readdirSync(jobsDir())) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(readFileSync(join(jobsDir(), f), 'utf8')) as JobSnapshot;
        const age = Date.now() - new Date(s.submittedAt).getTime();
        if (age > RETENTION_MS) unlinkSync(join(jobsDir(), f));
      } catch { /* 读不了的快照跳过 */ }
    }
  } catch { /* 目录不可读时跳过 */ }
}

export interface SubmitMeta {
  skill: string;
  label?: string;
}

export interface JobRunContext {
  signal: AbortSignal;
  /** 更新作业进度（写入快照） */
  reportProgress: (done: number, total: number, message: string) => void;
}

/** 分段计时：当前已累计毫秒（accumulated + 当前段；旧快照无分段字段时回退 elapsedMs） */
function currentElapsed(s: JobSnapshot, now: number): number {
  const acc = s.accumulatedMs ?? s.elapsedMs ?? 0;
  if (s.resumedAtMs === undefined) return acc;
  return acc + Math.max(0, now - s.resumedAtMs);
}

/** 分段计时：冻结到终态（累计值固化，重启/重读不再随墙钟增长） */
function freezeElapsed(s: JobSnapshot, now: number): number {
  const total = currentElapsed(s, now);
  s.accumulatedMs = total;
  delete s.resumedAtMs;
  s.elapsedMs = total;
  return total;
}

/** interrupted（server 重启遗留的 running 快照）冻结耗时：只认最后持久化的累计值，绝不随墙钟增长 */
function frozenElapsed(s: JobSnapshot): number {
  return s.accumulatedMs ?? s.elapsedMs ?? 0;
}

/** 提交作业：立即返回 jobId；fn 经 setImmediate 后台启动（先让提交方拿到响应） */
export function submitJob(
  fn: (ctx: JobRunContext) => Promise<unknown>,
  meta: SubmitMeta,
): JobHandle {
  purgeExpired();
  const jobId = `job-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const controller = new AbortController();
  const snapshot: JobSnapshot = {
    jobId, skill: meta.skill, label: meta.label, status: 'running',
    submittedAt: now, updatedAt: now,
    accumulatedMs: 0, resumedAtMs: Date.now(),
  };
  memory.set(jobId, { snapshot, controller });
  persist(snapshot);
  // 延迟到下一个事件循环迭代再启动：作业的同步前置阶段（启发式候选提取等）
  // 可能长时间阻塞单线程；先让提交方拿到响应（MCP stdio 写出依赖事件循环）
  const reportProgress = (done: number, total: number, message: string) => {
    snapshot.progress = { done, total, message };
    snapshot.elapsedMs = currentElapsed(snapshot, Date.now());
    touch(snapshot);
  };
  const run = async () => {
    try {
      const result = await fn({ signal: controller.signal, reportProgress });
      if (snapshot.status === 'cancelled') return;
      snapshot.status = 'done';
      snapshot.result = result;
      freezeElapsed(snapshot, Date.now());
      touch(snapshot);
    } catch (err) {
      if (snapshot.status === 'cancelled') return;
      snapshot.status = 'error';
      snapshot.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
      freezeElapsed(snapshot, Date.now());
      touch(snapshot);
    }
  };
  setImmediate(() => void run());
  return { jobId, status: snapshot.status };
}

/** 查询：内存优先；未命中读磁盘（running 快照 → interrupted，耗时冻结不再增长） */
export function getJob(jobId: string): JobSnapshot | null {
  purgeExpired();
  const entry = memory.get(jobId);
  if (entry) return { ...entry.snapshot };
  const file = jobFile(jobId);
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as JobSnapshot;
    if (s.status === 'running') {
      return {
        ...s,
        elapsedMs: frozenElapsed(s),
        status: 'interrupted',
        error: 'server 重启，作业中断；请重新提交',
      };
    }
    return s;
  } catch {
    return null;
  }
}

/** 全部作业摘要（内存 + 磁盘合并，磁盘去重，新的在前） */
export function listJobs(): JobSnapshot[] {
  purgeExpired();
  const out = new Map<string, JobSnapshot>();
  try {
    if (existsSync(jobsDir())) {
      for (const f of readdirSync(jobsDir())) {
        if (!f.endsWith('.json')) continue;
        try {
          const s = JSON.parse(readFileSync(join(jobsDir(), f), 'utf8')) as JobSnapshot;
          if (s.status === 'running') {
            out.set(s.jobId, { ...s, elapsedMs: frozenElapsed(s), status: 'interrupted', error: 'server 重启，作业中断；请重新提交' });
          } else {
            out.set(s.jobId, s);
          }
        } catch { /* 跳过坏文件 */ }
      }
    }
  } catch { /* 目录不可读 */ }
  for (const [id, entry] of memory) out.set(id, { ...entry.snapshot });
  return [...out.values()].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

/** 取消：AbortController 通知；正在飞的批自然落地后标记 cancelled（耗时冻结） */
export function cancelJob(jobId: string): JobSnapshot | null {
  const entry = memory.get(jobId);
  if (entry) {
    entry.controller.abort();
    entry.snapshot.status = 'cancelled';
    freezeElapsed(entry.snapshot, Date.now());
    touch(entry.snapshot);
    return { ...entry.snapshot };
  }
  const file = jobFile(jobId);
  if (!existsSync(file)) return null;
  const s = JSON.parse(readFileSync(file, 'utf8')) as JobSnapshot;
  if (s.status === 'running') {
    return { ...s, elapsedMs: frozenElapsed(s), status: 'interrupted', error: 'server 重启，无法取消；请重新提交' };
  }
  return s; // 已终态，无需取消
}

/** 终态判断（cleanup 用） */
function isTerminal(status: JobStatus): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled' || status === 'interrupted';
}

/**
 * 清理超龄终态作业（R5-2 cleanup/gc）：移除 updatedAt（回退 submittedAt）早于
 * cutoff 的 done/error/cancelled/interrupted 作业（内存 + 磁盘）。
 * 顺带规范化遗留 running 快照（elapsedMs 冻结持久化，去 resumedAtMs——修脏数据）。
 */
export function cleanupJobs(olderThanHours = 24): { removed: number; remaining: number } {
  const cutoff = Date.now() - olderThanHours * 3600_000;
  let removed = 0;
  // 内存态
  for (const [id, entry] of [...memory]) {
    const snap = entry.snapshot;
    if (snap.status === 'running') continue; // 运行中不清理
    const ts = new Date(snap.updatedAt ?? snap.submittedAt).getTime();
    if (isTerminal(snap.status) && ts < cutoff) {
      memory.delete(id);
      try { unlinkSync(jobFile(id)); } catch { /* 磁盘缺失无妨 */ }
      removed += 1;
    }
  }
  // 磁盘态
  try {
    if (existsSync(jobsDir())) {
      for (const f of readdirSync(jobsDir())) {
        if (!f.endsWith('.json')) continue;
        const p = join(jobsDir(), f);
        try {
          const s = JSON.parse(readFileSync(p, 'utf8')) as JobSnapshot;
          if (s.status === 'running') {
            // 遗留 running = 重启中断：冻结 elapsedMs 并持久化（内存态为准）
            if (memory.has(s.jobId)) continue;
            const { resumedAtMs: _dropped, ...rest } = s;
            void _dropped;
            const frozen = { ...rest, elapsedMs: frozenElapsed(s), status: 'interrupted' as JobStatus, error: s.error ?? 'server 重启，作业中断；请重新提交' };
            writeFileSync(p, JSON.stringify(frozen, null, 2), 'utf8');
            continue;
          }
          const ts = new Date(s.updatedAt ?? s.submittedAt).getTime();
          if (isTerminal(s.status) && ts < cutoff) {
            unlinkSync(p);
            removed += 1;
          }
        } catch { /* 坏文件跳过 */ }
      }
    }
  } catch { /* 目录不可读 */ }
  return { removed, remaining: listJobs().length };
}
