import { describe, expect, it } from 'vitest';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import {
  auditTeachingPackage,
  externalUrlRefs,
  extractNumbering,
} from '../core/qa/auditTeachingPackage.js';

const CLEAN_HTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>.a{fill:url(#g1)}</style></head><body><svg><rect fill="url(#g1)"/></svg><script>var x=1;</script></body></html>';

describe('audit_teaching_package（教学包验收）', () => {
  it('零外链：干净 HTML 通过；豁免内联 SVG url(#id) 与 data:', () => {
    expect(externalUrlRefs('url(#g1) url(data:image/png;base64,abc) url(https://x.com/a.png) url(pic.png)')).toEqual(['https://x.com/a.png', 'pic.png']);
    const r = auditTeachingPackage({ artifacts: { html: CLEAN_HTML } });
    if ('error' in r) throw new Error('unexpected');
    const c6 = r.report.find((c) => c.id === 'C6-zero-external')!;
    expect(c6.verdict).toBe('pass');
  });

  it('零外链：http/script src/fetch 命中即 fail 并触发 M11 红线', () => {
    const r = auditTeachingPackage({ artifacts: { html: '<script src="https://cdn.x.com/a.js"></script><script>fetch("https://api.x.com")</script>' } });
    if ('error' in r) throw new Error('unexpected');
    const c6 = r.report.find((c) => c.id === 'C6-zero-external')!;
    expect(c6.verdict).toBe('fail');
    expect(c6.evidence).toContain('http-url');
    expect(c6.evidence).toContain('script-src');
    expect(r.redlineTriggers.some((t) => t.redline === 'M11')).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('禁用词：学生材料命中教师信息 fail 带行号证据；教案不受约束', () => {
    const r = auditTeachingPackage({
      artifacts: {
        slides: '第 1 页\n本页包含评分锚点。',
        lessonPlan: '教案里的参考答案不受禁用词表约束。',
      },
    });
    if ('error' in r) throw new Error('unexpected');
    const c7 = r.report.find((c) => c.id === 'C7-forbidden-words')!;
    expect(c7.verdict).toBe('fail');
    expect(c7.evidence).toContain('评分锚点');
    expect(c7.evidence).toContain('行 2');
    expect(r.redlineTriggers.some((t) => t.redline === 'H1')).toBe(true);
  });

  it('占位符：待补/TODO 命中 fail', () => {
    const r = auditTeachingPackage({ artifacts: { slides: '本节待补。TODO: 补案例' } });
    if ('error' in r) throw new Error('unexpected');
    const ph = r.report.find((c) => c.id === 'C3-placeholders')!;
    expect(ph.verdict).toBe('fail');
    expect(ph.evidence).toContain('待补');
    expect(ph.evidence).toContain('TODO');
  });

  it('编号一致性：缺/多/顺序乱全部检出并触发 M3', () => {
    const r = auditTeachingPackage({
      artifacts: {
        slides: '选读 01 选读 03',
        reading: { pages: ['原文 选读 01', '解读 选读 03'] },
        html: '选读 03 选读 01 选读 99',
      },
      expectedNumbering: ['01', '02', '03'],
    });
    if ('error' in r) throw new Error('unexpected');
    const c5 = r.report.find((c) => c.id === 'C5-numbering')!;
    expect(c5.verdict).toBe('fail');
    expect(c5.evidence).toContain('缺 02');
    expect(c5.evidence).toContain('多 99');
    expect(c5.evidence).toContain('顺序乱');
    expect(r.redlineTriggers.some((t) => t.redline === 'M3')).toBe(true);
  });

  it('编号抽取：容忍前导零与多种前缀', () => {
    expect(extractNumbering('选读 01、案例 3、阅读编号 015')).toEqual(['01', '03', '15']);
  });

  it('来源字段：缺未提供口径与双缺题名作者检出（M5）', () => {
    const r = auditTeachingPackage({
      artifacts: {
        reading: { text: '[阅读编号 01] 张三. 某研究. 大会, 2026: 印刷页 3. 链接或 DOI：https://doi.org/10.1000/xyz.\n[阅读编号 02] 题名：未提供. 作者：未提供. 某会, 2026: 印刷页 9（分会场 A；PDF 第 9 页）. 链接或 DOI：未提供.' },
      },
    });
    if ('error' in r) throw new Error('unexpected');
    const c6 = r.report.find((c) => c.id === 'C6-source-fields')!;
    // 第一行有 DOI 合规，第二行双缺违规
    expect(c6.verdict).toBe('fail');
    expect(c6.evidence).toContain('双缺 1');
    expect(r.redlineTriggers.some((t) => t.redline === 'M5')).toBe(true);
  });

  it('配对校验：奇原文偶解读通过；标记缺失与奇数尾页 fail（M7）', () => {
    const okP = auditTeachingPackage({ artifacts: { reading: { pages: ['原文 群落稳定性', '解读 这一篇在问', '原文 频度定律', '解读 对应本章原理'] } } });
    if ('error' in okP) throw new Error('unexpected');
    expect(okP.report.find((c) => c.id === 'L2-pairing')!.verdict).toBe('pass');
    const bad = auditTeachingPackage({ artifacts: { reading: { pages: ['原文 群落稳定性', '解读 这一篇', '原文 孤立尾页'] } } });
    if ('error' in bad) throw new Error('unexpected');
    const p = bad.report.find((c) => c.id === 'L2-pairing')!;
    expect(p.verdict).toBe('fail');
    expect(p.evidence).toContain('末页无配对');
    expect(bad.redlineTriggers.some((t) => t.redline === 'M7')).toBe(true);
  });

  it('delegated 判项与 passed 语义：无文本不冒充通过；全过才 passed', () => {
    const none = auditTeachingPackage({ artifacts: {} });
    if ('error' in none) throw new Error('unexpected');
    expect(none.report.filter((c) => c.verdict === 'delegated').length).toBeGreaterThanOrEqual(4);
    expect(none.passed).toBe(false);
    const all = auditTeachingPackage({
      artifacts: {
        slides: { text: '群落稳定性与物种异步性。' },
        reading: { pages: ['原文 群落稳定性研究节选', '解读 对应稳定性概念'] },
        html: CLEAN_HTML,
      },
    });
    if ('error' in all) throw new Error('unexpected');
    expect(all.report.filter((c) => c.verdict === 'fail')).toEqual([]);
    expect(all.passed).toBe(true);
    expect(all.redlineTriggers).toEqual([]);
  });

  it('输入校验：artifacts 缺失报错', () => {
    expect(auditTeachingPackage({})).toHaveProperty('error');
  });

  it('执行器冒烟：fail 时 degraded 并列出判项', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('audit_teaching_package', {
      inputs: { artifacts: { html: '<script src="https://x.com/a.js"></script>' } },
    });
    expect(r.level).toBe('degraded');
    expect(r.degradationNote).toContain('C6-zero-external');
    const bad = await adapter.invokeSkill('audit_teaching_package', { inputs: {} });
    expect(bad.level).toBe('unavailable');
    expect(bad.errorCode).toBe('INVALID_INPUT');
  });
});
