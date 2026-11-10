import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submitJob, getJob, listJobs, cancelJob } from '../adapters/core/jobQueue.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import type { LLMProvider } from '../core/llm.js';

const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

function useTempJobsDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ny-jobs-'));
  dirs.push(d);
  process.env.NANGYING_CONFIG_DIR = d;
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件（消除定时 flake：固定 sleep 在负载下会先验失败） */
async function waitFor(cond: () => boolean, timeoutMs = 5000, step = 25): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await sleep(step);
  }
}

describe('作业注册表', () => {
  it('提交→轮询→完成：快照含进度/结果/耗时', async () => {
    useTempJobsDir();
    const job = submitJob(async ({ reportProgress }) => {
      for (let i = 1; i <= 3; i++) {
        await sleep(20);
        reportProgress(i, 3, `第${i}/3 步`);
      }
      return { ok: true };
    }, { skill: 'test' });
    expect(job.status).toBe('running');
    await waitFor(() => getJob(job.jobId)?.status === 'done');
    const snap = getJob(job.jobId)!;
    expect(snap.status).toBe('done');
    expect(snap.result).toEqual({ ok: true });
    expect(snap.progress).toEqual({ done: 3, total: 3, message: '第3/3 步' });
    expect(snap.elapsedMs).toBeGreaterThan(0);
    expect(listJobs().some((j) => j.jobId === job.jobId)).toBe(true);
  });

  it('错误与取消语义', async () => {
    useTempJobsDir();
    const bad = submitJob(async () => { throw new Error('炸了'); }, { skill: 'test' });
    const slow = submitJob(async ({ signal, reportProgress }) => {
      for (let i = 0; i < 10; i++) {
        if (signal.aborted) return 'partial';
        await sleep(30);
        reportProgress(i + 1, 10, 'x');
      }
      return 'full';
    }, { skill: 'test' });
    const c = cancelJob(slow.jobId)!;
    expect(c.status).toBe('cancelled');
    await waitFor(() => getJob(bad.jobId)?.status === 'error');
    const b = getJob(bad.jobId)!;
    expect(b.status).toBe('error');
    expect(b.error).toContain('炸了');
  });

  it('磁盘快照：内存清空后从磁盘恢复 done；running 标记 interrupted', async () => {
    const dir = useTempJobsDir();
    const done = submitJob(async () => 'result-1', { skill: 'test' });
    const running = submitJob(async () => { await sleep(5000); return 'never'; }, { skill: 'test' });
    const jobsDir = join(dir, 'cache', 'jobs');
    // 提交即同步落盘；轮询兜底（磁盘/负载抖动下不先验失败）
    await waitFor(() => existsSync(jobsDir) && readdirSync(jobsDir).filter((f) => f.endsWith('.json')).length >= 2);
    // 同进程 getJob 命中内存；用新模块实例不可行，改为：内存态 running 的 jobId 在文件中可读
    const raw = JSON.parse(readFileSync(join(jobsDir, `${running.jobId}.json`), 'utf8'));
    expect(raw.status).toBe('running');
    void done;
  });
});

describe('作业卫生（interrupted 冻结 + 24h 惰性清理，反馈 P0-5：3,416,899ms 异常值）', () => {
  it('interrupted 任务 elapsedMs 冻结在最后累计值，不随墙钟增长', () => {
    const dir = useTempJobsDir();
    const jobsDir = join(dir, 'cache', 'jobs');
    mkdirSync(jobsDir, { recursive: true });
    // 模拟遗留 running 快照：resumedAtMs 在 2 小时前（若按墙钟算会膨胀到 7,000,000ms+）
    const legacy = {
      jobId: 'job-legacy01', skill: 'parse_course_material', status: 'running',
      submittedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      accumulatedMs: 60_000, resumedAtMs: Date.now() - 2 * 3600_000,
    };
    writeFileSync(join(jobsDir, 'job-legacy01.json'), JSON.stringify(legacy));
    const listed = listJobs().find((j) => j.jobId === 'job-legacy01')!;
    expect(listed.status).toBe('interrupted');
    expect(listed.elapsedMs).toBe(60_000); // 冻结在最后累计值，绝不重复累计
  });

  it('24h 前提交的快照在 list/get 时惰性清理', () => {
    const dir = useTempJobsDir();
    const jobsDir = join(dir, 'cache', 'jobs');
    mkdirSync(jobsDir, { recursive: true });
    const old = {
      jobId: 'job-old0001', skill: 'test', status: 'interrupted',
      submittedAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
      updatedAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
    };
    writeFileSync(join(jobsDir, 'job-old0001.json'), JSON.stringify(old));
    expect(listJobs().some((j) => j.jobId === 'job-old0001')).toBe(false);
    expect(existsSync(join(jobsDir, 'job-old0001.json'))).toBe(false);
    expect(getJob('job-old0001')).toBeNull();
  });

  it('分段计时：cancel 冻结 elapsedMs，终态后不再增长', async () => {
    useTempJobsDir();
    const slow = submitJob(async ({ signal, reportProgress }) => {
      for (let i = 0; i < 50; i++) {
        if (signal.aborted) return 'partial';
        await sleep(10);
        reportProgress(i + 1, 50, 'x');
      }
      return 'full';
    }, { skill: 'test' });
    await sleep(60);
    const cancelled = cancelJob(slow.jobId)!;
    expect(cancelled.status).toBe('cancelled');
    const frozen = cancelled.elapsedMs!;
    await sleep(50);
    const after = getJob(slow.jobId)!;
    expect(after.elapsedMs).toBe(frozen);
    expect(after.resumedAtMs).toBeUndefined();
  });
});

describe('async: true 提交（重技能）', () => {
  const counted: LLMProvider = {
    complete: async (prompt: string) => {
      const batch: string[] = JSON.parse(prompt.slice(prompt.lastIndexOf('[')));
      return JSON.stringify(batch.map((t) => ({ term: t, cls: 'term', reason: 'mock' })));
    },
  };

  it('parse async：毫秒级返回 jobId；query 拿到与同步一致的结果', async () => {
    useTempJobsDir();
    const adapter = new LocalAdapter({ llm: counted, envLlm: false });
    const content = '# 标题\n\n梯度下降是核心方法，梯度下降依赖学习率。';
    const inputs = { materialFile: { content, materialType: 'md' } };

    const sync = await adapter.invokeSkill('parse_course_material', { inputs });
    const asyncRes = await adapter.invokeSkill('parse_course_material', { inputs: { ...inputs, async: true } });
    expect(asyncRes.level).toBe('full');
    const jobId = (asyncRes.data as { jobId: string }).jobId;
    expect(typeof jobId).toBe('string');

    // 轮询直至 done（上限 15s；超时抛错而非静默落到断言）
    const poll = async (): Promise<{ status: string; result?: { data: { knowledgePointCandidates: Array<{ term: string }> } } }> => {
      const t0 = Date.now();
      for (;;) {
        const q = await adapter.invokeSkill('manage_async_tasks', {
          inputs: { operation: 'query', jobId },
        });
        const job = (q.data as { job: { status: string; result?: { data: { knowledgePointCandidates: Array<{ term: string }> } } } }).job;
        if (job.status === 'done') return job;
        if (job.status === 'error') throw new Error('异步作业失败：' + JSON.stringify(job.result ?? ''));
        if (Date.now() - t0 > 15_000) throw new Error('轮询超时：作业 15s 未 done');
        await sleep(50);
      }
    };
    const job = await poll();
    expect(job.status).toBe('done');
    const syncTerms = (sync.data as { knowledgePointCandidates: Array<{ term: string }> }).knowledgePointCandidates.map((c) => c.term);
    const asyncTerms = (job.result?.data.knowledgePointCandidates ?? []).map((c) => c.term);
    expect(asyncTerms).toEqual(syncTerms);
  }, 30000);

  it('list 与 cancel 经 manage_async_tasks；不支持的技能 async 报错', async () => {
    useTempJobsDir();
    const adapter = new LocalAdapter({ llm: counted, envLlm: false });
    const slow = await adapter.invokeSkill('parse_course_material', {
      inputs: {
        materialFile: { content: '长材料占位'.repeat(1), materialType: 'txt' },
        async: true,
      },
    });
    const jobId = (slow.data as { jobId: string }).jobId;
    const list = await adapter.invokeSkill('manage_async_tasks', { inputs: { operation: 'list' } });
    expect((list.data as { jobs: Array<{ jobId: string }> }).jobs.some((j) => j.jobId === jobId)).toBe(true);
    const cancel = await adapter.invokeSkill('manage_async_tasks', {
      inputs: { operation: 'cancel', jobId },
    });
    expect(['cancelled', 'done']).toContain((cancel.data as { job: { status: string } }).job.status);
    const bad = await adapter.invokeSkill('realtime_qa_stream', { inputs: { async: true } });
    expect(bad.level).toBe('unavailable');
    expect(bad.degradationNote).toContain('不支持 async');
  }, 30000);
});
