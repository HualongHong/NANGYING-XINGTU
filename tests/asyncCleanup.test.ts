import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submitJob, cleanupJobs } from '../adapters/core/jobQueue.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

function useTempJobsDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ny-cleanup-'));
  dirs.push(d);
  process.env.NANGYING_CONFIG_DIR = d;
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('R5-2 cleanup/gc：超龄终态作业清理与脏数据规范化', () => {
  it('cleanup 移除超龄终态作业（磁盘+内存），保留新近作业', async () => {
    const dir = useTempJobsDir();
    // 新完成作业（内存）
    const fresh = submitJob(async () => 'new', { skill: 'test' });
    // 磁盘里的超龄 done 作业
    const jobsDir = join(dir, 'cache', 'jobs');
    mkdirSync(jobsDir, { recursive: true });
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    writeFileSync(join(jobsDir, 'job-old00001.json'), JSON.stringify({
      jobId: 'job-old00001', skill: 'test', status: 'done', result: 'x',
      submittedAt: old, updatedAt: old, elapsedMs: 100,
    }));
    await sleep(30); // 等 fresh 完成
    expect(cleanupJobs(24).removed).toBe(1);
    expect(existsSync(join(jobsDir, 'job-old00001.json'))).toBe(false);
    expect(cleanupJobs(24).removed).toBe(0); // 幂等
    void fresh;
  });

  it('cleanup 规范化遗留 running 快照：elapsedMs 冻结持久化（修 3,416,899ms 类脏数据）', () => {
    const dir = useTempJobsDir();
    const jobsDir = join(dir, 'cache', 'jobs');
    mkdirSync(jobsDir, { recursive: true });
    const twoHoursAgo = Date.now() - 2 * 3600_000;
    writeFileSync(join(jobsDir, 'job-dirty001.json'), JSON.stringify({
      jobId: 'job-dirty001', skill: 'parse_course_material', status: 'running',
      submittedAt: new Date(twoHoursAgo).toISOString(),
      updatedAt: new Date(twoHoursAgo).toISOString(),
      accumulatedMs: 60_000, resumedAtMs: twoHoursAgo, // 若按墙钟算是 7,200,000ms+
    }));
    cleanupJobs(24);
    const normalized = JSON.parse(readFileSync(join(jobsDir, 'job-dirty001.json'), 'utf8'));
    expect(normalized.status).toBe('interrupted');
    expect(normalized.elapsedMs).toBe(60_000); // 冻结在最后累计值
    expect(normalized.resumedAtMs).toBeUndefined();
  });

  it('manage_async_tasks cleanup/gc 端到端（olderThanHours 可配）', async () => {
    useTempJobsDir();
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('manage_async_tasks', {
      inputs: { operation: 'cleanup', olderThanHours: 1 },
    });
    expect(r.level).toBe('full');
    const data = r.data as { removed: number; remaining: number; olderThanHours: number };
    expect(data.olderThanHours).toBe(1);
    expect(typeof data.removed).toBe('number');
    const gc = await adapter.invokeSkill('manage_async_tasks', { inputs: { operation: 'gc' } });
    expect(gc.level).toBe('full');
    expect((gc.data as { olderThanHours: number }).olderThanHours).toBe(24); // 默认 24h
  });
});
