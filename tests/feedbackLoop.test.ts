import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  computeMetrics,
  evaluateThresholds,
  DEFAULT_THRESHOLDS,
  loadIndex,
} from '../scripts/feedback-loop.mjs';

const NOW = new Date('2026-11-10T00:00:00Z');

function entry(overrides: Record<string, unknown>) {
  return {
    docId: 'fb-x',
    acceptedAt: '2026-11-01T00:00:00Z',
    kind: 'suggestion',
    summary: 's',
    hasSensitive: false,
    ...overrides,
  };
}

describe('R16 反馈闭环指标（loop engineering）', () => {
  it('computeMetrics：分类/敏感占比/未消化问题/最老滞留天数', () => {
    const entries = [
      entry({ docId: 'a', kind: 'install_issue', acceptedAt: '2026-09-01T00:00:00Z' }),
      entry({ docId: 'b', kind: 'usage_issue' }),
      entry({ docId: 'c', kind: 'praise', hasSensitive: true }),
      entry({ docId: 'd', kind: 'usage_issue', consumed: true }),
    ];
    const m = computeMetrics(entries, NOW);
    expect(m.total).toBe(4);
    expect(m.byKind).toEqual({ install_issue: 1, usage_issue: 2, praise: 1 });
    expect(m.sensitiveCount).toBe(1);
    expect(m.sensitiveRatio).toBe(0.25);
    expect(m.unconsumedIssues).toBe(2); // consumed 不计入
    expect(m.oldestUnconsumedAgeDays).toBe(Math.floor((NOW.getTime() - new Date('2026-09-01T00:00:00Z').getTime()) / 86_400_000));
  });

  it('evaluateThresholds：样本量不足 → 未激活（CI 空库安全通过）', () => {
    const v = evaluateThresholds(computeMetrics([entry({})], NOW), DEFAULT_THRESHOLDS);
    expect(v.active).toBe(false);
    expect(v.breaches).toHaveLength(0);
  });

  it('evaluateThresholds：未消化积压 / 敏感占比 / 滞留天数超阈 → breach', () => {
    const entries = Array.from({ length: 4 }, (_, i) =>
      entry({ docId: `i${i}`, kind: i < 3 ? 'install_issue' : 'usage_issue', hasSensitive: i === 0, acceptedAt: '2026-09-01T00:00:00Z' }));
    const m = computeMetrics(entries, NOW);
    const v = evaluateThresholds(m, { ...DEFAULT_THRESHOLDS, maxUnconsumedIssues: 2, maxSensitiveAttachedRatio: 0.2, stalenessWarnDays: 7 });
    const metrics = v.breaches.map((b) => b.metric);
    expect(v.active).toBe(true);
    expect(metrics).toContain('unconsumedIssues');
    expect(metrics).toContain('sensitiveAttachedRatio');
    expect(metrics).toContain('oldestUnconsumedAgeDays');
  });

  it('evaluateThresholds：健康数据全绿', () => {
    const entries = [
      entry({ docId: 'a', kind: 'praise', consumed: true }),
      entry({ docId: 'b', kind: 'suggestion', consumed: true }),
      entry({ docId: 'c', kind: 'praise' }),
    ];
    const v = evaluateThresholds(computeMetrics(entries, NOW), DEFAULT_THRESHOLDS);
    expect(v.active).toBe(true);
    expect(v.breaches).toHaveLength(0);
  });
});

describe('R16 feedback-loop CLI', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ny-loop-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const script = join(process.cwd(), 'scripts', 'feedback-loop.mjs');

  it('空库：exit 0，门槛未激活', () => {
    const r = spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('门槛未激活');
  });

  it('breach：exit 1 并打印拦截清单', () => {
    for (let i = 0; i < 3; i += 1) {
      appendFileSync(join(dir, 'index.jsonl'), JSON.stringify(entry({ docId: `x${i}`, kind: 'install_issue', acceptedAt: '2026-09-01T00:00:00Z' })) + '\n');
    }
    const r = spawnSync(process.execPath, [script, '--root', dir, '--json'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.metrics.total).toBe(3);
    expect(report.verdict.breaches.length).toBeGreaterThan(0);
  });

  it('--consume：标记已消化后退出未消化计数', () => {
    appendFileSync(join(dir, 'index.jsonl'), JSON.stringify(entry({ docId: 'fixme', kind: 'usage_issue' })) + '\n');
    const c = spawnSync(process.execPath, [script, '--root', dir, '--consume', 'fixme'], { encoding: 'utf8' });
    expect(c.status).toBe(0);
    const { entries } = loadIndex(dir);
    expect(entries[0].consumed).toBe(true);
    const unknown = spawnSync(process.execPath, [script, '--root', dir, '--consume', 'nope'], { encoding: 'utf8' });
    expect(unknown.status).toBe(2);
  });
});
