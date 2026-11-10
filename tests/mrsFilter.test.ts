import { describe, expect, it } from 'vitest';
import {
  parseCourseMaterial,
  GENERIC_STOPWORDS,
} from '../core/nlp/parseCourseMaterial.js';

const terms = async (content: string) =>
  (await parseCourseMaterial({ content, materialType: 'txt' }))
    .data!.knowledgePointCandidates.map((c) => c.term);

describe('MRS（极大重复子串）', () => {
  it('错开窗口碎片一次清零："验现象进/行了细致的讨"类全灭，真术语存活', async () => {
    // 课件讨论页套话只出现一次（distinct=1）时碎片靠回退池也不进正式候选；
    // 反复出现的套话整串由 MRS 只保留不可再扩的极大子串
    const t = await terms([
      '基于实验现象进行了细致的讨论，学生分组汇报结果。',
      '本节围绕淀粉颗粒的提取流程，淀粉颗粒来自马铃薯块茎。',
      '离心是常用的分离手段，离心的转速决定效果，离心需要配平。',
    ].join('\n\n'));
    expect(t).toContain('离心');
    expect(t).toContain('淀粉颗粒');
    expect(t).not.toContain('验现象进');
    expect(t).not.toContain('行了细致的讨');
    expect(t).not.toContain('基于实验现象进行');
  });

  it('可扩展杀死短碎片、不可扩展保留术语：电泳被电泳技术吸收', async () => {
    const t = await terms([
      '电泳技术用于分离蛋白质，电泳技术依赖电场。',
      '本实验采用电泳技术，电泳技术的条件已优化。',
    ].join('\n\n'));
    expect(t).toContain('电泳技术');
    expect(t).not.toContain('电泳'); // 右扩"电泳技术"重复 ≥2 → 被吸收
  });

  it('两侧上下文各异的短术语保留：离心在散文中存活', async () => {
    const t = await terms([
      '离心的转速决定分离效果。',
      '样品需要离心，离心后取上清液。',
      '离心时间过长会破坏细胞结构。',
    ].join('\n\n'));
    expect(t).toContain('离心');
  });

  it('opts.extraStoplist 可追加自定义停用词', async () => {
    const content = '淀粉颗粒来自马铃薯，淀粉颗粒是本单元重点，马铃薯为实验材料。';
    const base = await parseCourseMaterial({ content, materialType: 'txt' });
    expect(base.data!.knowledgePointCandidates.map((c) => c.term)).toContain('马铃薯');
    const extra = await parseCourseMaterial({
      content, materialType: 'txt', options: { extraStoplist: ['马铃薯'] },
    });
    expect(extra.data!.knowledgePointCandidates.map((c) => c.term)).not.toContain('马铃薯');
  });
});

describe('通用词表与功能字规则', () => {
  it('通用动词/形容词全词匹配清除', async () => {
    const t = await terms([
      '过滤分离加入计算，准确避免处理设计称为属于。',
      '过滤分离加入计算，准确避免处理设计称为属于。',
    ].join('\n\n'));
    for (const w of ['过滤', '分离', '加入', '计算', '准确', '避免', '处理', '设计', '称为', '属于']) {
      expect(GENERIC_STOPWORDS.has(w)).toBe(true);
      expect(t).not.toContain(w);
    }
  });

  it('功能字/操作动词/方位尾规则：句子碎片拒，对硝基苯磷酸保', async () => {
    const t = await terms([
      '用蒸馏水洗涤，使蛋白质变性，按下表操作，沸水浴中加热。',
      '对硝基苯磷酸是底物，对硝基苯磷酸在碱性条件下水解。',
      '防止滤纸被手汗污染，点样时可用吹风机加速。',
      '用蒸馏水洗涤，使蛋白质变性，按下表操作，沸水浴中加热。',
    ].join('\n\n'));
    expect(t).toContain('对硝基苯磷酸');
    expect(t).not.toContain('用蒸馏水');
    expect(t).not.toContain('使蛋白质');
    expect(t).not.toContain('按下表操作');
    expect(t).not.toContain('沸水浴中');
  });

  it('叠字 AA 型拒绝（生生/汪汪），直链淀粉类不受影响', async () => {
    const t = await terms([
      '层析缸中生生成像，汪汪声为环境噪声。',
      '直链淀粉溶于热水，直链淀粉遇碘变蓝。',
      '层析缸中生生成像，汪汪声为环境噪声。',
    ].join('\n\n'));
    expect(t).not.toContain('生生');
    expect(t).not.toContain('汪汪');
    expect(t).toContain('直链淀粉');
  });
});
