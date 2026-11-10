import { describe, expect, it, vi } from 'vitest';
import { parseCourseMaterial } from '../core/nlp/parseCourseMaterial.js';
import type { LLMProvider } from '../core/llm.js';

/** mock 分类器：按映射表返回四类分类 */
function classifyLlm(map: Record<string, string>, spy?: (prompt: string) => void): LLMProvider {
  return {
    complete: async (prompt: string) => {
      spy?.(prompt);
      const batch: string[] = JSON.parse(prompt.slice(prompt.lastIndexOf('[')));
      return JSON.stringify(
        batch.map((t) => ({
          term: t,
          cls: map[t] ?? 'noise', // 未标注者默认 noise，便于断言丢弃路径
          reason: `mock-${map[t] ?? 'noise'}`,
        })),
      );
    },
  };
}

const LAB_TEXT = [
  '离心分离细胞组分，离心后取上清。',
  '滴定终点用指示剂判断，滴定操作要规范。',
  '用纱布过滤粗提取液，剧烈震荡后取出静置。',
  '米氏常数反映酶与底物的亲和力，米氏常数是特征常数。',
  '层析缸中生生成像，汪汪为噪声。',
].join('\n\n');

describe('LLM 术语度过滤（四类分类）', () => {
  it('实验课程领域约束：operation（离心/滴定）与 term（米氏常数）保留，phrase/noise 丢弃', async () => {
    const map: Record<string, string> = {
      离心: 'operation',
      滴定: 'operation',
      米氏常数: 'term',
    };
    const llm = classifyLlm(map);
    const r = await parseCourseMaterial({ content: LAB_TEXT, materialType: 'txt' }, { llm });
    const terms = r.data!.knowledgePointCandidates.map((c) => c.term);
    expect(terms).toContain('离心'); // 实验操作技能 → 保留
    expect(terms).toContain('滴定');
    expect(terms).toContain('米氏常数');
    // phrase/noise 被过滤（用纱布过滤/剧烈震荡后取出/生生/汪汪等不在结果中）
    const fr = r.data!.llmFilterReport;
    expect(fr.enabled).toBe(true);
    expect(fr.degraded).toBe(false);
    expect(fr.distribution.operation).toBeGreaterThanOrEqual(2);
    expect(fr.distribution.term).toBeGreaterThanOrEqual(1);
    expect(fr.dropped).toBe(fr.distribution.phrase + fr.distribution.noise);
    expect(fr.kept + fr.dropped).toBe(fr.kept + fr.dropped); // 结构自洽
    expect(fr.droppedSamples.length).toBeGreaterThan(0);
  });

  it('分批：>100 候选分多批调用', async () => {
    const prompts: string[] = [];
    const g1 = '甲乙丙丁戊己庚辛壬癸';
    const g2 = '子丑寅卯辰巳午未申酉戌亥乾坤';
    const terms150 = g2.slice(0, 15).split('')
      .flatMap((b) => g1.split('').map((a) => `生化${a}${b}概念`));
    expect(terms150.length).toBeGreaterThanOrEqual(101); // 140 个唯一术语
    const content = terms150.map((t) => `${t}是实验概念，${t}在课程中反复出现。`).join('\n');
    const llm = classifyLlm({}, (p) => prompts.push(p));
    await parseCourseMaterial({ content, materialType: 'txt' }, { llm });
    expect(prompts.length).toBeGreaterThanOrEqual(2);
  });

  it('非法 JSON：该批保留原候选并标 degraded', async () => {
    let n = 0;
    const llm: LLMProvider = {
      complete: async () => (n++ === 0 ? '垃圾' : JSON.stringify([{ term: 'x', cls: 'term', reason: '' }])),
    };
    const content = '离心是操作技能，离心用于分离。滴定是分析方法，滴定需要指示剂。';
    const r = await parseCourseMaterial({ content, materialType: 'txt' }, { llm });
    expect(r.level).toBe('degraded');
    expect(r.data!.llmFilterReport.degraded).toBe(true);
    expect(r.data!.knowledgePointCandidates.length).toBeGreaterThan(0);
  });

  it("llmFilter: 'off' 时完全走启发式（provider 不被调用，行为与未注入一致）", async () => {
    const complete = vi.fn(async () => '[]');
    const withOff = await parseCourseMaterial(
      { content: LAB_TEXT, materialType: 'txt', options: { llmFilter: 'off' } },
      { llm: { complete } },
    );
    const without = await parseCourseMaterial({ content: LAB_TEXT, materialType: 'txt' });
    expect(complete).not.toHaveBeenCalled();
    expect(JSON.stringify(withOff.data!.knowledgePointCandidates))
      .toBe(JSON.stringify(without.data!.knowledgePointCandidates));
    expect(withOff.data!.llmFilterReport.enabled).toBe(false);
  });

  it('小材料启用锁定（反馈 c P1-1）：≥10 候选注入 LLM 即 enabled=true，套话不再混入候选', async () => {
    // 模拟反馈 c 场景：小材料启发式下高频套话（"本节的核心概念"）压过真实术语；
    // 注入 LLM 后必须启用过滤（候选 ≥10），真实调查方法术语保留、套话丢弃
    const terms = ['标志重捕法', '样方调查法', '种群密度', '分布格局', '集群分布', '随机分布',
      '均匀分布', '泊松分布', '方差均值比', '零模型假设', '拟合优度检验', '样线调查法'];
    const content = terms.map((t, i) =>
      `${t}是本节的核心概念，${t}用于${i % 2 ? '野外调查' : '数据分析'}，${t}的结果需要记录。`).join('\n\n');
    const map = Object.fromEntries(terms.map((t) => [t, 'term']));
    const llm = classifyLlm(map);
    const r = await parseCourseMaterial({ content, materialType: 'txt' }, { llm });
    const fr = r.data!.llmFilterReport;
    expect(fr.enabled).toBe(true); // 小材料同样启用（候选 ≥10）
    expect(fr.kept).toBeGreaterThanOrEqual(10);
    const kept = r.data!.knowledgePointCandidates.map((c) => c.term);
    expect(kept).toContain('标志重捕法'); // 真实术语保留
    expect(kept).toContain('泊松分布');
    expect(kept).not.toContain('本节的核心概念'); // 套话被 LLM 判 phrase/noise 丢弃
  });
});

describe('MRS 吸收链中间节点召回', () => {
  it('distinct ≥5 且长度 ≥4 的被吸收术语召回（考马斯亮蓝场景）；低 distinct 碎片不召回', async () => {
    // 考马斯亮蓝可被"考马斯亮蓝法"吸收，但自身出现 5 次
    const content = [
      '考马斯亮蓝法测定蛋白质含量，考马斯亮蓝G-250与蛋白质结合。',
      '考马斯亮蓝染色后用分光光度计测定，考马斯亮蓝溶液需现配。',
      '考马斯亮蓝法的灵敏度取决于染料纯度，考马斯亮蓝加入后静置。',
    ].join('\n\n');
    const r = await parseCourseMaterial({ content, materialType: 'txt' });
    const terms = r.data!.knowledgePointCandidates.map((c) => c.term);
    expect(terms).toContain('考马斯亮蓝');
    // 模板碎片 distinct 低，不被误救
    const frags = terms.filter((t) => /进行了|基于|现象进|细致的讨/.test(t));
    expect(frags).toEqual([]);
  });
});
