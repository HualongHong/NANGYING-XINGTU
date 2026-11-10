import { describe, expect, it } from 'vitest';
import { parseCourseMaterial, stripHeaderFooters } from '../core/nlp/parseCourseMaterial.js';

describe('教材模式标题守卫', () => {
  it('习题行（句号/问号结尾、含疑问）不成标题', async () => {
    const content = [
      '第一章 绪论',
      '',
      '本章内容。',
      '',
      '1. 说明生态学的定义。',
      '2. 试举例说明生态学是研究什么问题的，采用什么样的方法。',
      '3. 比较三类生态学研究方法的利弊？',
    ].join('\n');
    const r = await parseCourseMaterial({ content, materialType: 'txt' });
    const titles = r.data!.structuredSections.map((s) => s.title);
    expect(titles).toEqual(['第一章 绪论']);
    // 习题内容仍在正文段落中
    const all = r.data!.paragraphs.map((p) => p.text).join('\n');
    expect(all).toContain('说明生态学的定义');
  });

  it('纯数字/小数行（16.8、2.0、6.34.9）不成标题', async () => {
    const content = [
      '1.1 光照强度',
      '',
      '正文段落一。',
      '16.8',
      '2.0',
      '6.34.9',
      '正文段落二。',
    ].join('\n');
    const r = await parseCourseMaterial({ content, materialType: 'txt' });
    const titles = r.data!.structuredSections.map((s) => s.title);
    expect(titles).toEqual(['1.1 光照强度']);
  });

  it('编号列表块（连续 ≥2 行整数编号短行）整段按正文处理', async () => {
    const content = [
      '1.1.2 生态因子',
      '',
      '生态因子概述。',
      '1. 生态因子的分类',
      '2. 生态因子作用特征',
      '',
      '分类与特征说明。',
    ].join('\n');
    const r = await parseCourseMaterial({ content, materialType: 'txt' });
    const titles = r.data!.structuredSections.map((s) => s.title);
    expect(titles).toEqual(['1.1.2 生态因子']);
    const all = r.data!.paragraphs.map((p) => p.text).join('\n');
    expect(all).toContain('生态因子的分类');
    expect(all).toContain('生态因子作用特征');
  });

  it('合法编号标题回归：1.1 样式 B 与 1. 样式 A（≤25 字、无标点收尾）仍成立', async () => {
    const content = [
      '1.1 什么是机器学习',
      '',
      '正文。',
      '1. 概述',
      '',
      '正文二。',
    ].join('\n');
    const r = await parseCourseMaterial({ content, materialType: 'txt' });
    expect(r.data!.structuredSections.map((s) => [s.title, s.level])).toEqual([
      ['1.1 什么是机器学习', 2],
      ['1. 概述', 1],
    ]);
  });

  it('页眉页脚行（短标题+页码出现 ≥3 次）被剔除，不进正文不进标题', async () => {
    const lines = [
      '基础生态学 15',
      '第一章 绪论',
      '',
      '正文第一段。',
      '基础生态学 16',
      '正文第二段。',
      '基础生态学 17',
      '正文第三段。',
      '基础生态学 18',
    ];
    const stripped = stripHeaderFooters(lines);
    expect(stripped.filter((l) => l.startsWith('基础生态学'))).toHaveLength(0);
    expect(stripped).toContain('正文第一段。');
    // 端到端：页眉页脚不参与标题与段落
    const r = await parseCourseMaterial({ content: lines.join('\n'), materialType: 'txt' });
    expect(r.data!.structuredSections.map((s) => s.title)).toEqual(['第一章 绪论']);
    const all = r.data!.paragraphs.map((p) => p.text).join('\n');
    expect(all).not.toContain('基础生态学 16');
    expect(all).toContain('正文第二段');
  });

  it('页眉页脚过滤不误伤：只出现 1-2 次的"短文本+数字"行保留', () => {
    const lines = ['图 3-1 生态因子分类', '正文', '表 2 生态学定义'];
    const stripped = stripHeaderFooters(lines);
    expect(stripped).toHaveLength(3);
  });
});

describe('重复页眉守卫与折行合并', () => {
  it('页眉式重复标题（同名相邻次序 ≥3 次）降级为正文', async () => {
    const content = [
      '1. 实验目的',
      '掌握比色法原理。',
      '2. 实验原理',
      '朗伯-比尔定律。',
      '2. 实验原理',
      '标准曲线绘制。',
      '2. 实验原理',
      '分光光度计使用。',
      '3. 器材与试剂',
      '试剂清单。',
    ].join('\n');
    const r = await parseCourseMaterial({ content, materialType: 'txt' });
    const titles = r.data!.structuredSections.map((s) => s.title);
    expect(titles).toEqual(['1. 实验目的', '3. 器材与试剂']);
    const all = r.data!.paragraphs.map((p) => p.text).join('\n');
    expect(all).toContain('实验原理');
  });

  it('章节型重复小节（次序间有其他标题）不误伤：讲义结构保留', async () => {
    const parts: string[] = [];
    for (let exp = 1; exp <= 4; exp++) {
      parts.push(
        `实验${exp}`,
        '',
        '一、目的要求',
        '目的说明。',
        '二、原理',
        '原理说明。',
        '三、试剂与器材',
        '器材说明。',
      );
    }
    const r = await parseCourseMaterial({ content: parts.join('\n'), materialType: 'txt' });
    const titles = r.data!.structuredSections.map((s) => s.title);
    expect(titles.filter((t) => t === '一、目的要求')).toHaveLength(4);
    expect(titles.filter((t) => t === '二、原理')).toHaveLength(4);
  });

  it('折行合并：无空行连续行并为一个段落，碎片重新拼接', async () => {
    const content = [
      '第一章 绪论',
      '',
      '蛋白质组成的复杂',
      '性决定了测定方法的选择。',
    ].join('\n');
    const r = await parseCourseMaterial({ content, materialType: 'txt' });
    expect(r.data!.paragraphs).toHaveLength(1);
    expect(r.data!.paragraphs[0].text).toBe('蛋白质组成的复杂性决定了测定方法的选择。');
  });

  it('弹性候选上限：小文档 20、大文档按字数扩展封顶 60（确定性）', async () => {
    const { elasticCandidateLimit } = await import('../core/nlp/parseCourseMaterial.js');
    const mk = (n: number) => [{ index: 0, text: '字'.repeat(n), sectionOrder: -1 }];
    expect(elasticCandidateLimit(mk(100))).toBe(20);
    expect(elasticCandidateLimit(mk(4000))).toBe(21);
    expect(elasticCandidateLimit(mk(20000))).toBe(25);
    expect(elasticCandidateLimit(mk(500000))).toBe(60);
    // 端到端：大文档两次运行候选一致（数量取决于不同术语数，上限行为由 elasticCandidateLimit 单测覆盖）
    const content = '课程总览\n\n' + '生态因子与生物的耐受限度及光合作用速率的关系。'.repeat(120);
    const a = await parseCourseMaterial({ content, materialType: 'txt' });
    const b = await parseCourseMaterial({ content, materialType: 'txt' });
    expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
  });
});

