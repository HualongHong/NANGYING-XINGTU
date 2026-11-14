import { describe, expect, it } from 'vitest';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import {
  buildNumberingMap,
  composeTeachingArtifacts,
  diffBaseline,
  renderSourceField,
  validateLayerBoundaries,
} from '../core/course/composeTeachingArtifacts.js';

const SELECTED = [
  { recordId: 'R2', title: '团粒结构形成机制研究', section: '3.2 土壤结构', score: 9, mustReview: false },
  { recordId: 'R1', title: '放牧对草原群落稳定性的影响', section: '3.1 草地生态', score: 8, mustReview: true },
  { recordId: 'R3', title: '土壤质地分类方法综述', section: '3.1 草地生态', score: 3, mustReview: false },
];

const RECORDS = [
  { id: 'R1', title: '放牧对草原群落稳定性的影响', authors: ['张三', '李四'], keywords: ['稳定性'], physicalPages: [47, 47], printedPage: 47, session: '分会场 A', excerpt: '节选文本', commentary: '解说文本', thinkQuestions: ['想一想 1'] },
  { id: 'R2', title: '团粒结构形成机制研究', authors: ['王五'], keywords: ['团粒结构'], physicalPages: [3, 4], printedPage: 1, session: '分会场 B' },
  { id: 'R3', title: '土壤质地分类方法综述', authors: [], keywords: [], physicalPages: [9, 9], session: '' },
];

describe('compose_teaching_artifacts（教学四件套组装）', () => {
  it('编号映射：按课程节顺序，节内按分降序，案例=阅读编号两位补零', () => {
    const order = ['3.1 草地生态', '3.2 土壤结构'];
    const map = buildNumberingMap(SELECTED, order);
    expect(map.map((m) => m.caseNo)).toEqual(['01', '02', '03']);
    expect(map[0]).toMatchObject({ recordId: 'R1', section: '3.1 草地生态' });
    expect(map[1]).toMatchObject({ recordId: 'R3' });
    expect(map[2]).toMatchObject({ recordId: 'R2', section: '3.2 土壤结构' });
    expect(map[0].mustReview).toBe(true);
  });

  it('来源字段：统一模板 + 未提供口径 + 印刷页/物理页双坐标', () => {
    const line = renderSourceField(
      { title: '放牧对草原群落稳定性的影响', authors: ['张三', '李四'], session: '分会场 A', physicalPages: [47, 47], printedPage: 47 },
      '01',
      { venue: '中国生态学大会摘要集', year: '2026' },
    );
    expect(line).toContain('[阅读编号 01]');
    expect(line).toContain('张三，李四');
    expect(line).toContain('印刷页 47');
    expect(line).toContain('PDF 第 47 页');
    expect(line).toContain('链接或 DOI：未提供');
  });

  it('来源字段：作者缺失标未提供，偏移未探测只给物理页', () => {
    const noAuthors = renderSourceField({ title: '某题名', authors: [], session: '', physicalPages: [9, 9] }, '05', {});
    expect(noAuthors).toContain('作者：未提供');
    expect(noAuthors).toContain('会议/出版物：未提供');
    expect(noAuthors).toContain('年份：未提供');
    expect(noAuthors).toContain('印刷页偏移未探测');
    expect(noAuthors).not.toContain('印刷页 9');
  });

  it('H1 信息边界：教师数据 token 出现在学生产物即违规列出', () => {
    const v = validateLayerBoundaries({
      slides: '本页讲解群落稳定性（无违规）。',
      html: '<html>本页包含评分锚点与参考答案。</html>',
    });
    expect(v.filter((x) => x.artifact === 'html').map((x) => x.token).sort()).toEqual(['参考答案', '评分锚点']);
    expect(v.some((x) => x.artifact === 'slides')).toBe(false);
    expect(validateLayerBoundaries({}, [])).toEqual([]);
  });

  it('基线 diff：变化项列出供增量确认', () => {
    const d = diffBaseline({ caseCount: 14, sections: 5 }, { caseCount: 15, sections: 5 });
    expect(d).toEqual([{ key: 'caseCount', before: 14, after: 15 }]);
    expect(diffBaseline({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it('主流程：四件套内容源 + numberingMap + sourceFields + 缺节选提示', () => {
    const r = composeTeachingArtifacts({
      selected: SELECTED,
      records: RECORDS,
      courseStructure: { sections: [{ title: '3.1 草地生态' }, { title: '3.2 土壤结构' }] },
      venue: '中国生态学大会摘要集',
      year: '2026',
      baseline: { caseCount: 14 },
    });
    if ('error' in r) throw new Error('unexpected');
    expect(r.numberingMap).toHaveLength(3);
    expect(r.sourceFields['01']).toContain('[阅读编号 01]');
    expect(r.sourceFields['01']).toContain('张三，李四');
    expect(r.sourceFields['02']).toContain('作者：未提供');
    expect(r.artifacts).toHaveLength(2);
    const sec1 = r.artifacts[0];
    expect(sec1.slides.caseNos).toEqual(['01', '02']);
    expect(sec1.reading.find((x) => x.caseNo === '01')!.excerptReady).toBe(true);
    expect(sec1.reading.find((x) => x.caseNo === '02')!.excerptReady).toBe(false);
    expect(r.baselineDiff).toEqual([
      { key: 'caseCount', before: 14, after: 3 },
      { key: 'sections', before: null, after: 2 },
    ]);
    expect(r.notes.some((n) => n.includes('必复核'))).toBe(true);
    expect(r.notes.some((n) => n.includes('缺原文节选'))).toBe(true);
    expect(r.degraded).toBe(false);
  });

  it('studentDrafts 送检：学生 HTML 含教师 token 进 violations', () => {
    const r = composeTeachingArtifacts({
      selected: SELECTED,
      records: RECORDS,
      studentDrafts: { html: '<p>设计理由如下</p>' },
    });
    if ('error' in r) throw new Error('unexpected');
    expect(r.violations).toEqual([{ artifact: 'html', token: '设计理由', count: 1 }]);
  });

  it('空 selected：degraded 空骨架（按 courseStructure 节序）；缺 selected 报错', () => {
    const empty = composeTeachingArtifacts({ selected: [], records: RECORDS, courseStructure: { sections: [{ title: '3.1 草地生态' }] } });
    if ('error' in empty) throw new Error('unexpected');
    expect(empty.degraded).toBe(true);
    expect(empty.numberingMap).toEqual([]);
    expect(empty.artifacts).toHaveLength(1);
    expect(composeTeachingArtifacts({})).toHaveProperty('error');
  });

  it('执行器冒烟：LocalAdapter 全链一次', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('compose_teaching_artifacts', {
      inputs: { selected: SELECTED, records: RECORDS, venue: '大会摘要集', year: '2026' },
    });
    expect(r.level).toBe('full');
    const data = r.data as { numberingMap: Array<{ caseNo: string }> };
    expect(data.numberingMap.map((n) => n.caseNo)).toEqual(['01', '02', '03']);
    const bad = await adapter.invokeSkill('compose_teaching_artifacts', { inputs: {} });
    expect(bad.level).toBe('unavailable');
  });
});
