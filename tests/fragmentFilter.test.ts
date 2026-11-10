import { describe, expect, it } from 'vitest';
import { parseCourseMaterial } from '../core/nlp/parseCourseMaterial.js';

/** 教材碎片案例：前缀/后缀碎片应被更长术语清除 */
const TEXTBOOK_FRAGMENTS = [
  '生物的生长发育受温度影响，生物的生长发育分为若干阶段。',
  '生物的生长发育还受光照调控。',
  '生物的生长发育存在最适温度范围。',
].join('\n\n');

describe('OCR 碎片过滤（教材模式）', () => {
  it('碎片"生物的生"被"生物的生长发育"清除，完整术语存活', async () => {
    const r = await parseCourseMaterial({ content: TEXTBOOK_FRAGMENTS, materialType: 'txt' });
    const terms = r.data!.knowledgePointCandidates.map((c) => c.term);
    expect(terms).toContain('生物的生长发育');
    expect(terms).not.toContain('生物的生');
  });

  it('包含型短语被两阶段去重清除："因子的耐受性"并入"生态因子的耐受性"', async () => {
    const content = [
      '生态因子的耐受性决定分布，生态因子的耐受性可以调整。',
      '生态因子的耐受性有上限，生态因子的耐受性随环境变化。',
      '耐受性是最低与最高之间的范围。',
    ].join('\n\n');
    const r = await parseCourseMaterial({ content, materialType: 'txt' });
    const terms = r.data!.knowledgePointCandidates.map((c) => c.term);
    expect(terms).toContain('生态因子的耐受性');
    expect(terms).not.toContain('因子的耐受性');
  });

  it('高频真术语不受碎片规则误伤："耐受限度"（后缀位置、容器更罕见）保留', async () => {
    const content = [
      '耐受限度决定生态幅，耐受限度可以调整，耐受限度是核心概念。',
      '生态因子的耐受限度与温度有关。',
      '耐受限度随环境变化，耐受限度有上限。',
    ].join('\n\n');
    const r = await parseCourseMaterial({ content, materialType: 'txt' });
    const terms = r.data!.knowledgePointCandidates.map((c) => c.term);
    expect(terms).toContain('耐受限度');
  });

  it('MRS 吸收链召回：监督学习/无监督学习均保留（中间节点召回，distinct ≥5）', async () => {
    const content = [
      '监督学习利用标签，监督学习是主流范式。',
      '无监督学习无需标签，无监督学习发现结构。',
      '监督学习与无监督学习互为补充。监督学习需要标注数据。',
    ].join('\n\n');
    const r = await parseCourseMaterial({ content, materialType: 'txt' });
    const terms = r.data!.knowledgePointCandidates.map((c) => c.term);
    expect(terms).toContain('无监督学习');
    expect(terms).toContain('监督学习'); // 吸收链中间节点召回（distinct ≥5 且长度 ≥4）
  });

  it('7-8 字完整术语可成候选（NGRAM_MAX=8）', async () => {
    const content = [
      '光照强度对生物的生长发育有显著影响，光照强度决定光合作用速率。',
      '光照强度随纬度变化，光照强度也随季节变化。',
      '生物的生长发育存在最适温度范围，生物的生长发育受光照调控。',
    ].join('\n\n');
    const r = await parseCourseMaterial({ content, materialType: 'txt' });
    const terms = r.data!.knowledgePointCandidates.map((c) => c.term);
    expect(terms).toContain('光照强度');
    expect(terms).toContain('生物的生长发育');
  });

  it('短语拼接被清理："因子的耐受限度"被清除，"耐受限度"存活', async () => {
    const content = [
      '耐受限度决定生态幅，耐受限度可以调整。',
      '生态因子的耐受限度与生物分布有关。',
      '耐受限度是耐受性定律的核心概念。',
    ].join('\n\n');
    const r = await parseCourseMaterial({ content, materialType: 'txt' });
    const terms = r.data!.knowledgePointCandidates.map((c) => c.term);
    expect(terms).toContain('耐受限度');
    expect(terms).not.toContain('因子的耐受限度');
  });
});
