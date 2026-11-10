import { describe, expect, it, vi } from 'vitest';
import { parseCourseMaterial } from '../core/nlp/parseCourseMaterial.js';
import type { LLMProvider } from '../core/llm.js';

const LECTURE_MD = `# 机器学习概述

机器学习是人工智能的重要分支，研究如何让计算机从数据中学习规律。

## 监督学习

监督学习利用带标签的数据训练模型。常见的监督学习包括分类与回归。

## 无监督学习

无监督学习处理没有标签的数据，典型方法有聚类。
`;

const LECTURE_CN = `第一章 绪论

机器学习是人工智能的重要分支。本章介绍机器学习的基本概念。

一、研究背景

人工智能的发展推动了机器学习的研究。机器学习广泛应用于图像识别与自然语言处理。

二、研究意义

掌握机器学习有助于理解智能系统。梯度下降是机器学习的核心优化方法。
`;

describe('章节识别', () => {
  it('识别 Markdown 标题层级', async () => {
    const result = await parseCourseMaterial({
      content: LECTURE_MD,
      materialType: 'md',
    });
    expect(result.level).toBe('full');
    const titles = result.data!.structuredSections.map((s) => [s.title, s.level]);
    expect(titles).toEqual([
      ['机器学习概述', 1],
      ['监督学习', 2],
      ['无监督学习', 2],
    ]);
  });

  it('识别中文编号模式（第X章 / 一、）', async () => {
    const result = await parseCourseMaterial({
      content: LECTURE_CN,
      materialType: 'txt',
    });
    const titles = result.data!.structuredSections.map((s) => [s.title, s.level]);
    expect(titles).toEqual([
      ['第一章 绪论', 1],
      ['一、研究背景', 2],
      ['二、研究意义', 2],
    ]);
  });
});

describe('段落切分', () => {
  it('空行分段、连续列表项并入同一段落', async () => {
    const content = [
      '# 概述',
      '',
      '第一段：机器学习的基础概念。',
      '',
      '- 列表项一',
      '- 列表项二',
      '',
      '第二段：总结。',
    ].join('\n');
    const result = await parseCourseMaterial({ content, materialType: 'md' });
    const texts = result.data!.paragraphs.map((p) => p.text);
    expect(texts).toHaveLength(3);
    expect(texts[1]).toContain('列表项一');
    expect(texts[1]).toContain('列表项二');
    // 段落应归属首个章节
    expect(result.data!.paragraphs.every((p) => p.sectionOrder === 0)).toBe(true);
  });
});

describe('知识点候选抽取', () => {
  it('高频术语命中、停用词不命中', async () => {
    const content = [
      '# 优化方法',
      '',
      '梯度下降是训练神经网络的核心方法。我们使用梯度下降更新模型参数。',
      '',
      '梯度下降的学习率需要仔细调节。随机梯度下降是常见的变体。',
    ].join('\n');
    const result = await parseCourseMaterial({ content, materialType: 'md' });
    const terms = result.data!.knowledgePointCandidates.map((c) => c.term);
    // 高频术语应排在前面
    expect(terms[0]).toContain('梯度下降');
    // 基础停用词不应作为候选
    expect(terms).not.toContain('我们');
    expect(terms).not.toContain('学习');
  });
});

describe('降级路径', () => {
  it('未知格式输入 → degraded + 纯文本直通', async () => {
    const content = '这是某二进制格式的可读文本\n第二行内容';
    const result = await parseCourseMaterial({
      content,
      materialType: 'docx-binary',
    });
    expect(result.level).toBe('degraded');
    expect(result.degradationNote).toContain('退化为纯文本提取');
    expect(result.data!.structuredSections).toEqual([]);
    expect(result.data!.paragraphs.map((p) => p.text)).toEqual([
      '这是某二进制格式的可读文本',
      '第二行内容',
    ]);
  });
});

describe('LLM 增强路径', () => {
  it('注入 mock provider → 走 LLM 精炼且 provider 被调用', async () => {
    const complete = vi.fn<(prompt: string, options?: unknown) => Promise<string>>(
      async () =>
        JSON.stringify([
          { term: '梯度下降', cls: 'term', reason: '优化算法术语' },
        ]),
    );
    const mockLlm: LLMProvider = { complete };
    const content = [
      '# 优化方法',
      '',
      '梯度下降用于最小化损失函数，梯度下降依赖学习率。',
      '我们使用梯度下降更新模型参数。',
    ].join('\n');
    const result = await parseCourseMaterial(
      { content, materialType: 'md' },
      { llm: mockLlm },
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0]).toContain('四类分类');
    expect(result.level).toBe('full');
    // 过滤语义：保留原候选中被分类为 term/operation 者（损失函数 distinct=1 未进候选池）
    expect(result.data!.knowledgePointCandidates.map((c) => c.term)).toEqual(['梯度下降']);
    const fr = result.data!.llmFilterReport;
    expect(fr.enabled).toBe(true);
    expect(fr.distribution.term).toBe(1);
  });

  it('LLM 返回非法内容时回落启发式候选', async () => {
    const mockLlm: LLMProvider = {
      complete: async () => '抱歉，我无法处理',
    };
    const result = await parseCourseMaterial(
      {
        content: '# 标题\n\n梯度下降是核心方法，梯度下降用于优化。',
        materialType: 'md',
      },
      { llm: mockLlm },
    );
    expect(result.level).toBe('degraded');
    expect(result.degradationNote).toContain('分类失败');
    expect(result.data!.knowledgePointCandidates.length).toBeGreaterThan(0);
    // 该批非法 → 保留原候选并标 degraded
    expect(result.data!.llmFilterReport.degraded).toBe(true);
    expect(result.data!.llmFilterReport.kept).toBe(result.data!.knowledgePointCandidates.length);
  });
});
