import { describe, expect, it } from 'vitest';
import { parseCourseMaterial, normalizeCourseText } from '../core/nlp/parseCourseMaterial.js';

describe('R3-6 parse 选项（反馈 b P2：normalize/language/glossary）', () => {
  it('normalize：全角空格/弯引号/全角括号清洗（默认关闭，缺省行为不变）', async () => {
    const raw = '# 绪论\n\n种群密度　是"最基本的"数量特征（见教材）。';
    const on = await parseCourseMaterial(
      { content: raw, materialType: 'md', options: { normalize: true } },
    );
    const off = await parseCourseMaterial({ content: raw, materialType: 'md' });
    const onText = on.data!.paragraphs.map((p) => p.text).join('\n');
    expect(onText).toContain('种群密度 是"最基本的"数量特征(见教材)。');
    expect(onText).not.toContain('　');
    expect(onText).not.toContain('“');
    const offText = off.data!.paragraphs.map((p) => p.text).join('\n');
    expect(offText).toContain('　'); // 默认不清洗
  });

  it('normalizeCourseText：确定性纯函数', () => {
    expect(normalizeCourseText('a　b　　c')).toBe('a b c');
    expect(normalizeCourseText('“引号”（括号）')).toBe('"引号"(括号)');
  });

  it('language：透传标注于输出', async () => {
    const r = await parseCourseMaterial(
      { content: '# 标题\n\n内容。', materialType: 'md', options: { language: 'zh' } },
    );
    expect(r.data!.language).toBe('zh');
    const plain = await parseCourseMaterial({ content: '# 标题\n\n内容。', materialType: 'md' });
    expect(plain.data!.language).toBeUndefined();
  });

  it('glossary：表内术语在文中出现即强制入池（跳过停用过滤）', async () => {
    const content = '# 生态学\n\n本次课介绍标志重捕法，标志重捕法用于野外调查。';
    const withG = await parseCourseMaterial(
      { content, materialType: 'md', options: { glossary: ['标志重捕法', '未出现的术语'] } },
    );
    const terms = withG.data!.knowledgePointCandidates.map((c) => c.term);
    expect(terms).toContain('标志重捕法');
    expect(terms).not.toContain('未出现的术语'); // 文中未出现不入池
    const c = withG.data!.knowledgePointCandidates.find((x) => x.term === '标志重捕法')!;
    expect(c.score).toBeGreaterThanOrEqual(1);
  });
});
