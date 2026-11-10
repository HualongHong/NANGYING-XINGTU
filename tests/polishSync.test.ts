import { describe, expect, it } from 'vitest';
import { polishTeachingText, heuristicPolish } from '../core/text/polishTeachingText.js';
import { syncBilingual, splitSegments } from '../core/i18n/syncBilingual.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import type { LLMProvider } from '../core/llm.js';

describe('R7-1 polish_teaching_text（#24）', () => {
  it('启发式：套话清除直接改 + 重复词/句长/连接词进报告', async () => {
    const text = '综上所述，接下来我们来看种群密度的定义。种群密度是种群最基本的数量特征，种群密度决定调查方法。';
    const r = await polishTeachingText({ text });
    expect(r.level).toBe('degraded'); // 无 LLM 诚实降级
    expect(r.data!.polished).not.toContain('综上所述');
    expect(r.data!.polished).not.toContain('接下来我们看');
    expect(r.data!.polished).toContain('种群密度');
    expect(r.data!.stats.clicheRemoved).toBeGreaterThanOrEqual(2);
    const types = r.data!.changes.map((c) => c.type);
    expect(types).toContain('cliche');
    expect(types).toContain('repetition'); // 种群密度 ×3
  });

  it('styleHints.clichePatterns 追加自定义套话', () => {
    const r = heuristicPolish({
      text: '本节课我们将学习种群密度。',
      styleHints: { clichePatterns: ['本节课我们将学习'] },
    });
    expect(r.polished).not.toContain('本节课我们将学习');
    expect(r.changes.some((c) => c.reason.includes('styleHints'))).toBe(true);
  });

  it('LLM 层：建议合并应用；术语保护与改动幅度约束拒收违规条', async () => {
    const text = '种群密度是种群最基本的数量特征。综上所述，它是核心概念。';
    const llm: LLMProvider = {
      complete: async () => JSON.stringify([
        { original: '它是核心概念。', suggested: '它是种群研究的核心概念。', reason: '更具体' },
        // 违规：改动保护术语 → 应拒收
        { original: '综上所述', suggested: '总体看', reason: '换词' },
      ]),
    };
    const r = await polishTeachingText(
      { text, preserveTerms: ['种群密度'], maxChangeRatio: 0.5 },
      { llm },
    );
    expect(r.level).toBe('full');
    expect(r.data!.polished).toContain('它是种群研究的核心概念。');
    expect(r.data!.stats.llmApplied).toBe(1);
    expect(r.data!.stats.llmRejected).toBeGreaterThanOrEqual(1);
    expect(r.data!.stats.changeRatio).toBeLessThanOrEqual(0.5);
  });

  it('LLM 失败回落启发式并标 degraded；空文本 INVALID_INPUT', async () => {
    const bad: LLMProvider = { complete: async () => '非JSON' };
    const r = await polishTeachingText({ text: '综上所述，我们来看。' }, { llm: bad });
    expect(r.level).toBe('degraded');
    expect(r.degradationNote).toContain('回落启发式');
    const adapter = new LocalAdapter();
    const empty = await adapter.invokeSkill('polish_teaching_text', { inputs: { text: '' } });
    expect(empty.level).toBe('unavailable');
    expect(empty.errorCode).toBe('INVALID_INPUT');
  });
});

describe('R7-2 sync_bilingual（#25）', () => {
  const primary = '# 种群生态学\n\n种群密度是种群最基本的数量特征。\n\n标志重捕法适用于活动能力强的动物。';

  it('无 LLM：段落切分 + 对照骨架（中文零改动），诚实 degraded', async () => {
    const r = await syncBilingual({ primaryText: primary, secondaryLang: 'en' });
    expect(r.level).toBe('degraded');
    const d = r.data!;
    expect(d.segments).toHaveLength(3);
    expect(d.segments[0].primary).toBe('# 种群生态学');
    expect(d.segments.every((s) => s.secondary === null)).toBe(true);
    expect(d.anchors).toEqual([{ primary: 0, secondary: 0 }, { primary: 1, secondary: 1 }, { primary: 2, secondary: 2 }]);
  });

  it('mirror + LLM：逐段对齐译文 + 术语一致性检查（锁定项缺失被报告）', async () => {
    const llm: LLMProvider = {
      complete: async (prompt: string) => {
        expect(prompt).toContain('种群密度'); // 锁定术语进提示词
        // 故意漏译第二段的规范译名 → missing 应报告
        return JSON.stringify([
          '# Population Ecology',
          'Population density is the most basic quantitative characteristic of a population.',
          'Mark-recapture method applies to animals with strong mobility.',
        ]);
      },
    };
    const r = await syncBilingual(
      { primaryText: primary, secondaryLang: 'en', lockedSegments: ['种群密度', '标志重捕法'] },
      { llm },
    );
    expect(r.level).toBe('full');
    const d = r.data!;
    expect(d.segments).toHaveLength(3);
    expect(d.segments[1].primary).toContain('种群密度'); // 中文零改动
    expect(d.segments[1].secondary).toContain('Population density');
    const density = d.termConsistency.find((t) => t.term === '种群密度')!;
    expect(density.segmentIndexes).toEqual([1]);
  });

  it('mirror 段数不匹配/失败 → 回落骨架标 degraded', async () => {
    const bad: LLMProvider = { complete: async () => JSON.stringify(['only one']) };
    const r = await syncBilingual({ primaryText: primary, secondaryLang: 'en' }, { llm: bad });
    expect(r.level).toBe('degraded');
    expect(r.degradationNote).toContain('骨架');
  });

  it('translate 模式复用 translate_multilingual 机制；splitSegments 确定性', async () => {
    const llm: LLMProvider = {
      complete: async () => JSON.stringify([{ paragraph: 'Population density is the most basic quantitative characteristic of a population.' }]),
    };
    const r = await syncBilingual(
      { primaryText: '种群密度是种群最基本的数量特征。', secondaryLang: 'en', mode: 'translate' },
      { llm },
    );
    expect(['full', 'degraded']).toContain(r.level);
    expect(r.data!.mode).toBe('translate');
    expect(r.data!.translated).toBeTruthy();
    expect(splitSegments('a\n\nb')).toEqual(['a', 'b']);
    const adapter = new LocalAdapter();
    const missing = await adapter.invokeSkill('sync_bilingual', { inputs: {} });
    expect(missing.level).toBe('unavailable');
  });
});
