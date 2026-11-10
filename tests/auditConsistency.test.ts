import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heuristicConflicts, auditConsistency } from '../core/qa/auditConsistency.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import type { LLMProvider } from '../core/llm.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('R4-4 audit_consistency（技能 #23，反馈 a 4.2-N1）', () => {
  const syllabus = { id: '大纲', title: '教学大纲', text: '总学时：96。期末考试：2026年12月28日。总学分：4。覆盖种群密度、标志重捕法。' };
  const calendar = { id: '日历', title: '教学日历', text: '总学时：64。期末考试：2026年12月20日。总学分：4。按周安排教学。' };

  it('启发式：日期/学时冲突 high，口径一致项不报', () => {
    const conflicts = heuristicConflicts([syllabus, calendar]);
    const types = conflicts.map((c) => c.type);
    expect(types).toContain('date');
    expect(types).toContain('hours');
    expect(conflicts.find((c) => c.type === 'date')!.severity).toBe('high');
    expect(conflicts.find((c) => c.type === 'hours')!.assets).toEqual(['大纲', '日历']);
    // 总学分一致 → 无 number 冲突
    expect(types).not.toContain('number');
    // 冲突项带建议
    for (const c of conflicts) expect(c.suggestion.length).toBeGreaterThan(0);
  });

  it('数值口径冲突：同一指标名取值不同', () => {
    const conflicts = heuristicConflicts([
      { id: 'A', text: '实验次数：8 次。' },
      { id: 'B', text: '实验次数：6 次。' },
    ]);
    const num = conflicts.find((c) => c.type === 'number');
    expect(num).toBeTruthy();
    expect(num!.description).toContain('实验次数');
  });

  it('端到端：path 由适配层读取；冲突清单与统计输出', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ny-audit-'));
    dirs.push(dir);
    const p = join(dir, '日历.md');
    writeFileSync(p, calendar.text);
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('audit_consistency', {
      inputs: { assets: [{ id: '大纲', text: syllabus.text }, { id: '日历', path: p }] },
    });
    expect(r.level).toBe('full');
    const data = r.data as { conflicts: Array<{ type: string }>; checkedAssets: number; stats: { byType: Record<string, number> } };
    expect(data.checkedAssets).toBe(2);
    expect(data.conflicts.length).toBeGreaterThanOrEqual(2);
    expect(data.stats.byType.date + data.stats.byType.hours).toBeGreaterThanOrEqual(2);
  });

  it('LLM 兜底复核：补充语义冲突并去重；失败保留启发式结果并标 degraded', async () => {
    const llm: LLMProvider = {
      complete: async () => JSON.stringify([
        { type: 'coverage', assetIds: ['大纲', '日历'], description: '大纲声称覆盖标志重捕法，日历未安排对应实验周', suggestion: '在日历补充实验周' },
      ]),
    };
    const r = await auditConsistency({ assets: [syllabus, calendar] }, { llm });
    expect(['full', 'degraded']).toContain(r.level);
    expect(r.data!.conflicts.some((c) => c.type === 'coverage')).toBe(true);
    // 启发式冲突仍在
    expect(r.data!.conflicts.some((c) => c.type === 'hours')).toBe(true);

    const badLlm: LLMProvider = { complete: async () => '垃圾输出' };
    const degraded = await auditConsistency({ assets: [syllabus, calendar] }, { llm: badLlm });
    expect(degraded.level).toBe('degraded');
    expect(degraded.degradationNote).toContain('启发式');
    expect(degraded.data!.conflicts.length).toBeGreaterThan(0);
  });

  it('形态守卫：少于 2 项 → unavailable + INVALID_INPUT；无冲突 → 空清单诚实返回', async () => {
    const adapter = new LocalAdapter();
    const one = await adapter.invokeSkill('audit_consistency', {
      inputs: { assets: [{ id: 'A', text: '总学时：32。' }] },
    });
    expect(one.level).toBe('unavailable');
    expect(one.errorCode).toBe('INVALID_INPUT');

    const clean = await adapter.invokeSkill('audit_consistency', {
      inputs: {
        assets: [
          { id: 'A', text: '总学时：32。期末考试：2026年12月28日。' },
          { id: 'B', text: '总学时：32。期末考试：2026年12月28日。' },
        ],
      },
    });
    expect(clean.level).toBe('full');
    expect((clean.data as { conflicts: unknown[] }).conflicts).toEqual([]);
  });
});
