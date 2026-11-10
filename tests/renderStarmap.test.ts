import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { renderStarmapSvg, renderStarmapHtml } from '../core/graph/renderStarmap.js';
import { conceptNodeId, type CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';

function makeGraph(opts: {
  concepts?: string[];
  related?: Array<[string, string, number]>;
  sections?: Array<{ title: string; level: number; children?: Array<{ title: string; level: number }> }>;
}): CourseKnowledgeGraph {
  const entities = (opts.concepts ?? []).map((label, i) => ({
    id: conceptNodeId(label), kind: 'concept' as const, label, level: 0, order: i,
  }));
  const relations = (opts.related ?? []).map(([a, b, w]) => ({
    id: `edge-${conceptNodeId(a)}->${conceptNodeId(b)}:related`,
    from: conceptNodeId(a), to: conceptNodeId(b), type: 'related' as const, weight: w,
  }));
  const hierarchy = (opts.sections ?? []).map((s, i) => ({
    id: `sec-${i}`, title: s.title, level: s.level, order: i,
    children: (s.children ?? []).map((c, j) => ({
      id: `sec-${i}-${j}`, title: c.title, level: c.level, order: j, children: [],
    })),
  }));
  const nodes = [
    ...entities,
    ...hierarchy.flatMap(function collect(s): Array<{ id: string }> {
      return [{ id: s.id }, ...s.children.flatMap(collect)];
    }),
  ];
  return {
    entities,
    relations,
    hierarchy,
    prerequisiteGraph: {
      nodes: nodes.map((n) => n.id),
      edges: [],
      topoOrder: nodes.map((n) => n.id),
    },
  };
}

describe('renderStarmap', () => {
  it('确定性：两次渲染逐字节一致', () => {
    const g = makeGraph({
      concepts: ['离心', '比色法', '电泳'],
      related: [['离心', '电泳', 3]],
      sections: [{ title: '第一章 绪论', level: 1, children: [{ title: '1.1 实验', level: 2 }] }],
    });
    expect(renderStarmapSvg(g)).toBe(renderStarmapSvg(g));
  });

  it('空图谱输出占位文案与合法 SVG 结构', () => {
    const svg = renderStarmapSvg(makeGraph({}));
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('空图谱');
  });

  it('章节为轨道标签，概念为星点（含标题转义）', () => {
    const g = makeGraph({
      concepts: ['离心<技术>'],
      sections: [{ title: '第一章 绪论', level: 1 }],
    });
    const svg = renderStarmapSvg(g);
    expect(svg).toContain('第一章 绪论');
    expect(svg).toContain('离心&lt;技术&gt;');
    expect(svg).toContain('<title>离心&lt;技术&gt;</title>');
  });

  it('related 边按权重连线', () => {
    const g = makeGraph({ concepts: ['甲', '乙'], related: [['甲', '乙', 4]] });
    const svg = renderStarmapSvg(g);
    const m = /<line class="edge-r"[^>]*stroke-width="([^"]+)"/.exec(svg);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(1); // weight 4 → 加粗
  });

  it('HTML 包装自包含（内联 SVG，无脚本/外链资源）', () => {
    const html = renderStarmapHtml(makeGraph({ concepts: ['离心'] }), '生化实验星图');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('生化实验星图');
    expect(html).toContain('<svg');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('src=');
    expect(html).not.toContain('href=');
  });
});

describe('R11-1 星图多图谱类型识别与渲染', () => {
  const snapGraph = (): CourseKnowledgeGraph => ({
    entities: ['离心', '比色法'].map((label, i) => ({
      id: conceptNodeId(label), kind: 'concept' as const, label, level: 0, order: i,
    })),
    relations: [{ id: 'e1', from: conceptNodeId('离心'), to: conceptNodeId('比色法'), type: 'related', weight: 2 }],
    hierarchy: [{ id: 'sec-0', title: '第一章 绪论', level: 1, order: 0, children: [] }],
    prerequisiteGraph: { nodes: [conceptNodeId('离心'), conceptNodeId('比色法')], edges: [], topoOrder: [conceptNodeId('离心'), conceptNodeId('比色法')] },
  });

  it('conceptual 行为逐字节不变（sha256 快照锁定）', () => {
    const svg = renderStarmapSvg(snapGraph());
    expect(createHash('sha256').update(svg, 'utf8').digest('hex'))
      .toBe('eab60d1392b1f846c3b5fa5d89b7fa3f2e7e3bfba1d8ea8f1add4d0717ce4f14');
  });

  it('industry：六类本体分区 + 图例计数 + 五类关系线型', async () => {
    const { buildIndustryGraph } = await import('../core/graph/buildIndustryGraph.js');
    const r = await buildIndustryGraph({
      sections: [{
        title: '生物医药检测',
        fields: {
          岗位: ['质检工程师', '研发工程师'],
          工作任务: ['产品放行检验'],
          技能要求: ['分光光度法', 'GLP 规范'],
          工具: ['紫外分光光度计'],
          趋势: ['监管趋严'],
        },
      }],
    });
    const svg = renderStarmapSvg(r.data!);
    expect(svg).toContain('产业星图');
    expect(svg).toContain('class="legend"');
    // 图例：六类本体中文名 + 计数
    for (const name of ['产业/环节', '岗位', '工作任务', '技能要求', '工具技术', '趋势政策']) {
      expect(svg).toContain(name);
    }
    expect(svg).toMatch(/岗位 ×2/);
    expect(svg).toMatch(/技能要求 ×2/);
    // 五类关系各自线型（实线/虚线/点线/点划/长划）
    for (const cls of ['e-iho', 'e-oht', 'e-trs', 'e-sut', 'e-tds']) {
      expect(svg).toContain(`class="${cls}"`);
    }
    expect(svg).toContain('stroke-dasharray:1 4'); // task_requires_skill 点线
    // 确定性
    expect(renderStarmapSvg(r.data!)).toBe(svg);
  });

  it('experimental：八类实体分区 + step_order 弧形连边 + 图例', async () => {
    const { extractExperimentalGraph } = await import('../core/graph/extractExperimentalGraph.js');
    const r = await extractExperimentalGraph({
      sections: [{
        title: '实验一 蛋白质含量测定',
        fields: {
          依据标准: ['GB/T 5009.5'], 样品: ['大豆粉'], 指标: ['蛋白质含量'],
          仪器: ['分光光度计', '离心机'], 操作步骤: ['标准曲线绘制', '样品显色', '比色测定'],
          质控: ['平行样'], 产出: ['吸光度数据'], 难点: ['显色时间控制'],
        },
      }],
    });
    const svg = renderStarmapSvg(r.data as unknown as CourseKnowledgeGraph);
    expect(svg).toContain('实验星图');
    for (const name of ['实验', '标准', '样品', '指标', '仪器', '操作步骤', '质控', '产出', '难点']) {
      expect(svg).toContain(name);
    }
    expect(svg).toMatch(/操作步骤 ×3/);
    // step_order 顺序链 → 弧形 path（Q 曲线），不再是直线
    expect(svg).toContain('class="e-step"');
    expect(svg).toMatch(/<path class="e-step" d="M[\d.]+,[\d.]+ Q[\d.]+,[\d.]+ [\d.]+,[\d.]+"\/>/);
    expect(svg).toContain('操作链（step_order）');
    expect(renderStarmapSvg(r.data as unknown as CourseKnowledgeGraph)).toBe(svg);
  });

  it('fused：课程/产业两侧边框区分 + 来源图例 + 各边沿用所属线型', () => {
    const g: CourseKnowledgeGraph = {
      schemaVersion: '1.2',
      entities: [
        { id: 'con-1', kind: 'concept', label: '分光光度法', level: 0, order: 0, source: { sectionOrder: [0], paragraphIndexes: [1] } },
        { id: 'con-2', kind: 'concept', label: '标准曲线', level: 0, order: 1 },
        { id: 'ind-1', kind: 'concept', label: '质检工程师', level: 0, order: 2, nodeType: 'occupation' },
        { id: 'ind-2', kind: 'concept', label: 'GLP 规范', level: 0, order: 3, nodeType: 'skill' },
      ],
      relations: [
        { id: 'e1', from: 'con-1', to: 'con-2', type: 'related', weight: 2 },
        { id: 'e2', from: 'ind-1', to: 'ind-2', type: 'task_requires_skill', weight: 1 },
      ],
      hierarchy: [],
      prerequisiteGraph: { nodes: ['con-1', 'con-2', 'ind-1', 'ind-2'], edges: [], topoOrder: [] },
    };
    const svg = renderStarmapSvg(g);
    expect(svg).toContain('融合星图');
    // 产业侧节点橙色虚线边框区分课程侧
    expect(svg).toContain('stroke="#ff9f6e" stroke-width="1.6" stroke-dasharray="3 2"');
    // 来源图例（con-1 带 source → 课程侧 ×1）
    expect(svg).toContain('课程侧 ×1');
    // 产业关系沿用产业线型，概念间 related 细实线
    expect(svg).toContain('class="e-trs"');
    expect(svg).toContain('class="e-fg"');
    expect(renderStarmapSvg(g)).toBe(svg);
  });

  it('detectStarmapKind：graphType 标记与 nodeType/type 推断', async () => {
    const { detectStarmapKind } = await import('../core/graph/renderStarmap.js');
    const { buildIndustryGraph } = await import('../core/graph/buildIndustryGraph.js');
    const { extractExperimentalGraph } = await import('../core/graph/extractExperimentalGraph.js');
    expect(detectStarmapKind(makeGraph({ concepts: ['离心'] }))).toBe('conceptual');
    const ind = await buildIndustryGraph({ sections: [{ title: '检测', fields: { 岗位: ['质检工程师'] } }] });
    expect(detectStarmapKind(ind.data!)).toBe('industry');
    const exp = await extractExperimentalGraph({ sections: [{ title: '实验', fields: { 样品: ['大豆粉'] } }] });
    expect(detectStarmapKind(exp.data as unknown as CourseKnowledgeGraph)).toBe('experimental');
  });
});
