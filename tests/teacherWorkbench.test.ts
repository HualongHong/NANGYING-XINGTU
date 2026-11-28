import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import { writeApiKey } from '../adapters/core/configStore.js';
import { resetRedactCache } from '../adapters/core/redact.js';
import type { WorkbenchReport } from '../adapters/core/workbench.js';

let tmp: string;
let savedConfigDir: string | undefined;
let savedTrace: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'workbench-'));
  savedConfigDir = process.env.NANGYING_CONFIG_DIR;
  process.env.NANGYING_CONFIG_DIR = join(tmp, 'cfg');
  savedTrace = process.env.NANGYING_TRACE;
  process.env.NANGYING_TRACE = '1';
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

type WbResult = { level: string; data: { report: WorkbenchReport; writtenHtml?: string }; degradationNote?: string };

describe('teacher_workbench 教师工作台', () => {
  it('json 模式：报告结构齐备（引擎/配置/作业/轨迹/知识库/反馈）', async () => {
    const adapter = new LocalAdapter();
    await adapter.invokeSkill('describe_capabilities', { inputs: {} }); // 产生一条轨迹
    const r = (await adapter.invokeSkill('teacher_workbench', { inputs: {} })) as unknown as WbResult;
    expect(r.level).toBe('full');
    const { report } = r.data;
    expect(report.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.host.node).toBe(process.version);
    expect(report.engines.length).toBeGreaterThanOrEqual(2);
    expect(['builtin', 'optional-not-installed', 'not-provided']).toContain(report.engines[0].status);
    expect(report.traces.total).toBeGreaterThanOrEqual(1);
    expect(report.traces.bySkill.some((s) => s.skill === 'describe_capabilities')).toBe(true);
    expect(report.traces.successRate).toBeGreaterThan(0);
    expect(Array.isArray(report.knowledgeBases)).toBe(true);
    expect(report.feedback.total).toBe(0);
    expect(report.jobs.running).toBe(0);
  });

  it('配置脱敏：密钥名可见、密钥值绝不出现在报告中', async () => {
    writeApiKey('sk-workbench-secret-999999', 'mineruApiKey');
    resetRedactCache();
    const adapter = new LocalAdapter();
    const r = (await adapter.invokeSkill('teacher_workbench', { inputs: {} })) as unknown as WbResult;
    expect(r.data.report.settings.secretNames).toContain('mineruApiKey');
    expect(JSON.stringify(r.data.report)).not.toContain('sk-workbench-secret-999999');
  });

  it('html 模式：默认落 configDir/workbench.html，单文件含关键区块', async () => {
    const adapter = new LocalAdapter();
    const r = (await adapter.invokeSkill('teacher_workbench', { inputs: { format: 'html' } })) as unknown as WbResult;
    expect(r.level).toBe('full');
    const html = r.data.writtenHtml!;
    expect(html).toBe(join(tmp, 'cfg', 'workbench.html'));
    const content = readFileSync(html, 'utf8');
    expect(content).toContain('教师工作台');
    expect(content).toContain('引擎状态');
    expect(content).toContain('执行统计');
    expect(content).toContain('反馈闭环');
    expect(content).not.toContain('<script'); // 零依赖无脚本
  });

  it('html 显式 outputPath：正常路径写出；禁区路径结构化拒绝', async () => {
    const adapter = new LocalAdapter();
    const ok = (await adapter.invokeSkill('teacher_workbench', {
      inputs: { format: 'html', outputPath: join(tmp, 'out', 'dash.html') },
    })) as unknown as WbResult;
    expect(ok.level).toBe('full');
    expect(existsSync(join(tmp, 'out', 'dash.html'))).toBe(true);

    const bad = (await adapter.invokeSkill('teacher_workbench', {
      inputs: { format: 'html', outputPath: join(tmp, 'cfg', 'kb', 'x.html') },
    })) as unknown as WbResult;
    expect(bad.level).toBe('unavailable');
    expect((bad as unknown as { errorCode: string }).errorCode).toBe('INVALID_INPUT');
  });

  it('format 非法返回 INVALID_INPUT', async () => {
    const adapter = new LocalAdapter();
    const r = (await adapter.invokeSkill('teacher_workbench', { inputs: { format: 'pdf' } })) as unknown as WbResult;
    expect(r.level).toBe('unavailable');
  });

  it('days 窗口生效：days=-1 时轨迹统计为零', async () => {
    const adapter = new LocalAdapter();
    await adapter.invokeSkill('describe_capabilities', { inputs: {} });
    const r = (await adapter.invokeSkill('teacher_workbench', { inputs: { days: -1 } })) as unknown as WbResult;
    expect(r.data.report.traces.total).toBe(0);
    expect(r.data.report.traces.successRate).toBe(1);
  });
});
