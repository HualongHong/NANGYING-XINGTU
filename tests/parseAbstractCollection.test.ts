import { describe, expect, it } from 'vitest';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import {
  detectPageOffset,
  extractPrintedCandidates,
  parseAbstractCollection,
  planParseAbstractCollection,
  toPrintedPage,
} from '../core/nlp/parseAbstractCollection.js';

/** 造 n 页：前 skip 页无页码，其后印刷页 1..（物理页 = 印刷页 + skip，模拟前言/封面） */
const paged = (n: number, skip: number, body = '摘要正文内容。') =>
  Array.from({ length: n }, (_, i) => (i < skip ? `${body}` : `${body}\n${i + 1 - skip}`));

describe('parse_abstract_collection（摘要集解析）', () => {
  it('页号偏移：恒值 Δ 探测（物理=印刷+Δ）', () => {
    const pages = paged(8, 3);
    const off = detectPageOffset(pages);
    expect(off).toEqual({ kind: 'constant', delta: 3 });
    expect(toPrintedPage(off, 4)).toBe(1);
    expect(toPrintedPage(off, 8)).toBe(5);
  });

  it('页号偏移：前言罗马页码 + 正文重启分段', () => {
    const pages = [
      '前言一\ni',
      '前言二\nii',
      '正文第一条摘要内容。\n1',
      '正文第二条摘要内容。\n2',
      '正文第三条摘要内容。\n3',
      '正文第四条摘要内容。\n4',
    ];
    const off = detectPageOffset(pages);
    expect(off.kind).toBe('segmented');
    if (off.kind !== 'segmented') return;
    expect(off.segments[0]).toMatchObject({ roman: true, from: 1, to: 2 });
    expect(off.segments[1]).toMatchObject({ delta: 2, from: 3, to: 6 });
    expect(toPrintedPage(off, 3)).toBe(1);
    expect(toPrintedPage(off, 1)).toBeUndefined();
  });

  it('页号偏移：样本不足报 unavailable', () => {
    const off = detectPageOffset(['只有一页\n1', '两页\n2']);
    expect(off.kind).toBe('unavailable');
  });

  it('印刷页码候选：优先末行纯数字行，罗马数字可解析', () => {
    expect(extractPrintedCandidates('标题\n内容\n47')).toEqual({ arabic: 47 });
    expect(extractPrintedCandidates('ix\n正文')).toEqual({ roman: 9 });
    expect(extractPrintedCandidates('没有任何页码')).toEqual({});
  });

  it('content 按 \\f 自动切段并探测偏移', () => {
    const content = ['第一页\n1', '第二页\n2', '第三页\n3', '第四页\n4'].join('\f');
    const r = parseAbstractCollection({ content });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.pageOffset).toEqual({ kind: 'constant', delta: 0 });
  });

  it('entryPattern 切分：编号前缀剥离 + 分会场归属 + 印刷页换算', () => {
    const pages = [
      '目录页\n分会场 A 草地生态\n1',
      '0001 放牧对草原群落稳定性的影响\n张三，李四\n北京大学生态研究中心 100871\n关键词：稳定性；异步性\n本文研究了放牧强度对群落稳定性的影响。\n2',
      '0002 频度定律的验证\n王五\n南京土壤研究所 210008\n关键词：频度\n本文验证了 Raunkiaer 频度定律。\n3',
    ];
    const r = parseAbstractCollection({ pages, entryPattern: '^\\d{4}\\s' });
    if ('error' in r) throw new Error('unexpected');
    expect(r.records).toHaveLength(2);
    const [r1, r2] = r.records;
    expect(r1.title).toBe('放牧对草原群落稳定性的影响');
    expect(r1.authors).toEqual(['张三', '李四']);
    expect(r1.keywords).toEqual(['稳定性', '异步性']);
    expect(r1.session).toContain('分会场 A');
    expect(r1.printedPage).toBe(2);
    expect(r2.printedPage).toBe(3);
    expect(r2.defects).not.toContain('affiliation_missing');
  });

  it('缺陷旗标：跨页断裂与长题名', () => {
    const longTitle = `0001 ${'一个特别'.repeat(15)}的题名`;
    const pages = [
      `${longTitle}\n张三，李四\n某大学某学院 100000\n本文没有句号就断了\n1`,
      '0002 正常题名\n王五\n某大学 200000\n关键词：测试\n正文完整。\n2',
    ];
    const r = parseAbstractCollection({ pages, entryPattern: '^\\d{4}\\s' });
    if ('error' in r) throw new Error('unexpected');
    expect(r.records[0].defects).toContain('cross_page_break');
    expect(r.records[0].defects).toContain('title_eats_author');
    expect(r.records[1].defects).toEqual([]);
  });

  it('预切分 records 归一化：字段缺省给安全缺省，缺题名 incomplete', () => {
    const pages = paged(4, 0);
    const r = parseAbstractCollection({
      pages,
      records: [{ title: '完整题名', authors: ['甲'], physicalPage: 2 }, { body: '没有题名的记录', physicalPage: 3 }],
    });
    if ('error' in r) throw new Error('unexpected');
    expect(r.records).toHaveLength(2);
    expect(r.records[0].status).toBe('parsed');
    expect(r.records[1].status).toBe('incomplete');
    expect(r.records[1].defects).toContain('title_missing');
  });

  it('无 entryPattern 且无 records：degraded，只出分会场归属与偏移', () => {
    const r = parseAbstractCollection({ pages: paged(4, 0, '分会场 B 内容') });
    if ('error' in r) throw new Error('unexpected');
    expect(r.degraded).toBe(true);
    expect(r.records).toEqual([]);
    expect(r.notes.some((n) => n.includes('entryPattern'))).toBe(true);
  });

  it('declaredTotal 给覆盖率，差额如实呈现', () => {
    const r = parseAbstractCollection({ pages: paged(4, 0), records: [{ title: '甲', physicalPage: 1 }], declaredTotal: 100 });
    if ('error' in r) throw new Error('unexpected');
    expect(r.coverage).toEqual({ parsed: 1, declaredTotal: 100, ratio: 0.01 });
  });

  it('输入校验：三者都缺与非法正则不通过', () => {
    expect(parseAbstractCollection({})).toHaveProperty('error');
    expect(planParseAbstractCollection({ content: 'x', entryPattern: '(\\d' }).ok).toBe(false);
    expect(planParseAbstractCollection({ content: 'x', declaredTotal: 0 }).ok).toBe(false);
  });

  it('执行器冒烟：pages 直传与缺输入守卫', async () => {
    const adapter = new LocalAdapter();
    const ok = await adapter.invokeSkill('parse_abstract_collection', {
      inputs: { pages: paged(5, 2), records: [{ title: '甲', physicalPage: 3 }] },
    });
    expect(ok.level).toBe('full');
    const data = ok.data as { records: Array<{ printedPage?: number }> };
    expect(data.records[0].printedPage).toBe(1);
    const bad = await adapter.invokeSkill('parse_abstract_collection', { inputs: {} });
    expect(bad.level).toBe('unavailable');
    expect(bad.errorCode).toBe('INVALID_INPUT');
  });
});
