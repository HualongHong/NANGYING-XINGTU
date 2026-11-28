import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import { readTraces, tracesDir } from '../adapters/core/execTrace.js';
import { writeApiKey } from '../adapters/core/configStore.js';
import { resetRedactCache } from '../adapters/core/redact.js';

let tmp: string;
let savedConfigDir: string | undefined;
let savedTrace: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'trace-'));
  savedConfigDir = process.env.NANGYING_CONFIG_DIR;
  process.env.NANGYING_CONFIG_DIR = join(tmp, 'cfg');
  savedTrace = process.env.NANGYING_TRACE;
  process.env.NANGYING_TRACE = '1'; // vitest 下默认关闭，测试显式打开
  resetRedactCache();
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.NANGYING_CONFIG_DIR;
  else process.env.NANGYING_CONFIG_DIR = savedConfigDir;
  if (savedTrace === undefined) delete process.env.NANGYING_TRACE;
  else process.env.NANGYING_TRACE = savedTrace;
  resetRedactCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('execTrace 执行轨迹', () => {
  it('技能调用落轨迹：技能名/等级/耗时/平台齐备', async () => {
    const adapter = new LocalAdapter();
    await adapter.invokeSkill('describe_capabilities', { inputs: {} });
    const traces = readTraces({ days: 1 });
    expect(traces.length).toBeGreaterThan(0);
    const t = traces[traces.length - 1];
    expect(t.skill).toBe('describe_capabilities');
    expect(t.ok).toBe(true);
    expect(['full', 'degraded']).toContain(t.level);
    expect(t.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof t.platform).toBe('string');
    expect(Number.isNaN(Date.parse(t.ts))).toBe(false);
  });

  it('未注册技能记 unavailable；执行器异常记 error 且错误脱敏', async () => {
    const adapter = new LocalAdapter();
    await adapter.invokeSkill('no_such_skill', { inputs: {} });
    writeApiKey('sk-trace-secret-123456');
    resetRedactCache();
    const broken = new LocalAdapter();
    broken.registerSkill(
      {
        skillId: 'boom_skill', name: 'x', description: 'x', type: 'shared',
        inputs: [], outputs: [], dependsOn: [], degradation: '', docPath: 'skills/shared/x.md',
      },
      () => { throw new Error('provider 401 key sk-trace-secret-123456'); },
    );
    await expect(broken.invokeSkill('boom_skill', { inputs: {} })).rejects.toThrow();
    const traces = readTraces({ days: 1 });
    const miss = traces.find((t) => t.skill === 'no_such_skill');
    expect(miss).toMatchObject({ ok: false, level: 'unavailable' });
    const boom = traces.find((t) => t.skill === 'boom_skill');
    expect(boom).toMatchObject({ ok: false, level: 'error' });
    expect(boom!.error).toContain('***');
    expect(boom!.error).not.toContain('sk-trace-secret-123456');
  });

  it('NANGYING_TRACE=0 时不落盘', async () => {
    process.env.NANGYING_TRACE = '0';
    const adapter = new LocalAdapter();
    await adapter.invokeSkill('describe_capabilities', { inputs: {} });
    expect(readTraces({ days: 1 })).toEqual([]);
    expect(readdirSync(tmp, { recursive: true }).filter((f) => String(f).includes('traces'))).toEqual([]);
  });

  it('readTraces 按月文件读取并支持 days 过滤', async () => {
    const adapter = new LocalAdapter();
    await adapter.invokeSkill('describe_capabilities', { inputs: {} });
    expect(readdirSync(tracesDir()).some((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))).toBe(true);
    expect(readTraces({ days: -1 }).length).toBe(0); // cutoff 在未来，全部滤掉
    expect(readTraces({ days: 1 }).length).toBeGreaterThan(0);
  });
});
