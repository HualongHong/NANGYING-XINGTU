import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createGlossary,
  upsertTerm,
  removeTerm,
  exportGlossary,
  importGlossary,
  normalizeTerm,
  findTermHits,
  enforceTerminology,
  type GlossaryEntry,
} from '../core/i18n/glossary.js';

const ML_ENTRIES: GlossaryEntry[] = [
  { term: '梯度下降', lang: 'zh', translations: { en: 'gradient descent' } },
  { term: '损失函数', lang: 'zh', translations: { en: 'loss function' } },
  { term: '随机梯度下降', lang: 'zh', translations: { en: 'stochastic gradient descent' } },
  { term: 'learning rate', lang: 'en', translations: { zh: '学习率', en: 'learning rate' } },
];

describe('术语库基础操作', () => {
  it('导入/导出 JSON 往返一致，且按 term 确定性排序', () => {
    const g = createGlossary([...ML_ENTRIES].reverse());
    // 排序确定性：与 localeCompare('zh') 一致
    for (let i = 1; i < g.entries.length; i++) {
      expect(g.entries[i - 1].term.localeCompare(g.entries[i].term, 'zh')).toBeLessThanOrEqual(0);
    }
    const round = importGlossary(exportGlossary(g));
    expect(round).toEqual(g);
  });

  it('upsert/remove 后保持排序', () => {
    let g = createGlossary(ML_ENTRIES);
    g = upsertTerm(g, { term: '过拟合', lang: 'zh', translations: { en: 'overfitting' } });
    expect(g.entries.map((e) => e.term)).toContain('过拟合');
    g = upsertTerm(g, { term: '梯度下降', lang: 'zh', translations: { en: 'Gradient Descent v2' } });
    expect(g.entries.filter((e) => e.term === '梯度下降')).toHaveLength(1);
    g = removeTerm(g, 'learning rate');
    expect(g.entries.map((e) => e.term)).not.toContain('learning rate');
  });

  it('导入非法 JSON 结构报错', () => {
    expect(() => importGlossary('{"foo": 1}')).toThrow('结构非法');
    expect(() => importGlossary('{"entries": [{"term": "x"}]}')).toThrow('缺少');
  });

  it('规范化：全半角与大小写', () => {
    expect(normalizeTerm('ＧＲＡＤＩＥＮＴ　ｄｅｓｃｅｎｔ')).toBe('gradient descent');
    expect(normalizeTerm('ＬＯＳＳ')).toBe('loss');
  });
});

describe('术语命中与一致性强制', () => {
  it('命中：最长优先（随机梯度下降不截断为梯度下降）', () => {
    const g = createGlossary(ML_ENTRIES);
    const hits = findTermHits('随机梯度下降与梯度下降都是优化方法', g);
    expect(hits.map((h) => h.matchedText)).toEqual(['随机梯度下降', '梯度下降']);
  });

  it('命中：大小写与全半角不敏感', () => {
    const g = createGlossary(ML_ENTRIES);
    const hits = findTermHits('请调节 LEARNING　RATE 参数', g);
    expect(hits.map((h) => h.matchedText)).toEqual(['LEARNING　RATE']);
  });

  it('强制替换：源语术语残留在目标语文本中被纠正并记录', () => {
    const g = createGlossary(ML_ENTRIES);
    const { text, items } = enforceTerminology('梯度下降 是核心方法', g, 'en');
    expect(text).toBe('gradient descent 是核心方法');
    expect(items).toHaveLength(1);
    expect(items[0].action).toBe('replaced');
    expect(items[0].expected).toBe('gradient descent');
  });

  it('规范译法的大小写变体视为一致（kept，不改动）', () => {
    const g = createGlossary(ML_ENTRIES);
    const { text, items } = enforceTerminology('we use Gradient Descent here', g, 'en');
    expect(text).toBe('we use Gradient Descent here');
    expect(items[0].action).toBe('kept');
  });
});

describe('机器学习示例课种子词表', () => {
  it('fixture 词表可导入且条目充足', () => {
    const raw = readFileSync('tests/fixtures/glossary.ml-basics.json', 'utf8');
    const g = importGlossary(raw);
    expect(g.entries.length).toBeGreaterThanOrEqual(15);
    expect(g.entries.length).toBeLessThanOrEqual(25);
    // 导出往返一致
    expect(importGlossary(exportGlossary(g))).toEqual(g);
    // 关键术语齐备
    for (const t of ['梯度下降', '损失函数', '监督学习', '无监督学习', '过拟合', '正则化']) {
      expect(g.entries.map((e) => e.term)).toContain(t);
    }
  });
});
