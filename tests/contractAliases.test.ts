import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

const adapter = new LocalAdapter();

// 资产类技能默认落盘到 NANGYING_CONFIG_DIR：隔离到临时目录，不碰真实 ~/.nangying-starmap
const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});
function useTempConfigDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ny-alias-'));
  dirs.push(d);
  process.env.NANGYING_CONFIG_DIR = d;
  return d;
}

/** 最小可用的 parse 输出（满足 extract 的子字段校验） */
function miniParsed() {
  return {
    structuredSections: [{ title: '第一章', level: 1, order: 0 }],
    paragraphs: [
      { index: 0, text: '梯度下降是核心优化方法，梯度下降依赖学习率。', sectionOrder: 0 },
      { index: 1, text: '学习率决定参数更新的步长。', sectionOrder: 0 },
    ],
    knowledgePointCandidates: [{ term: '梯度下降', score: 10 }],
  };
}

function miniObjectives() {
  return { audience: '本科生', totalMinutes: 30 };
}

describe('契约别名归一化（旧注册表名/用户猜测名 → 契约真名）', () => {
  it('design_course_structure：knowledgeGraph/teachingObjectives 别名自动改写为 graph/objectives', async () => {
    const parsed = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: { content: '# 标题\n\n梯度下降是核心方法，梯度下降依赖学习率。', materialType: 'md' } },
    });
    const extracted = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { structuredContent: parsed.data },
    });
    // 反馈 a/c 实测形态：按旧 schema 名 knowledgeGraph + teachingObjectives 传参
    const r = await adapter.invokeSkill('design_course_structure', {
      inputs: {
        knowledgeGraph: JSON.stringify(extracted.data), // 字符串化对象亦应自动解析
        teachingObjectives: miniObjectives(),
      },
    });
    expect(r.level).toBe('full');
    const data = r.data as { teachingStructure: unknown };
    expect(data.teachingStructure).toBeTruthy();
  });

  it('manage_course_assets：assetOperations 别名（单元素数组自动解包）', async () => {
    useTempConfigDir();
    const r = await adapter.invokeSkill('manage_course_assets', {
      inputs: {
        assetOperations: [{ op: 'register', asset: { id: 'alias-1', type: 'graph', title: '别名登记', dependencies: [] } }],
      },
    });
    expect(r.level).toBe('full');
    const data = r.data as { assetRegistry: Array<{ id: string }> };
    expect(data.assetRegistry.map((a) => a.id)).toContain('alias-1');
  });

  it('extract_knowledge_graph：structuredContent 传 JSON 字符串自动解析（反馈 P0-2）', async () => {
    const r = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { structuredContent: JSON.stringify(miniParsed()) },
    });
    expect(r.level).toBe('full');
    const data = r.data as { entities: unknown[] };
    expect(data.entities.length).toBeGreaterThan(0);
  });

  it('fuse_knowledge_graphs：单图对象自动包成数组（幂等）', async () => {
    const extracted = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { structuredContent: miniParsed() },
    });
    const r = await adapter.invokeSkill('fuse_knowledge_graphs', {
      inputs: { graphs: extracted.data, sources: [{ id: '讲义' }] },
    });
    expect(r.level).toBe('full');
  });

  it('generate_teaching_script：courseStructure 别名', async () => {
    const parsed = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: { content: '# 标题\n\n梯度下降是核心方法，梯度下降依赖学习率。', materialType: 'md' } },
    });
    const extracted = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { structuredContent: parsed.data },
    });
    const designed = await adapter.invokeSkill('design_course_structure', {
      inputs: { graph: extracted.data, objectives: miniObjectives() },
    });
    const r = await adapter.invokeSkill('generate_teaching_script', {
      inputs: { courseStructure: JSON.stringify(designed.data) },
    });
    expect(r.level).toBe('full');
  });
});

describe('describe_capabilities（技能 #21：能力自述，P1-2 可发现性）', () => {
  it('缺省返回全部 21 个技能的入参契约（真名/别名/必填/kind/上游/降级/用法）', async () => {
    const r = await adapter.invokeSkill('describe_capabilities', { inputs: {} });
    expect(r.level).toBe('full');
    const data = r.data as {
      count: number;
      skills: Array<{
        skillId: string;
        usage: string;
        degradation: string;
        required: string[];
        inputs: Array<{ name: string; kind: string; required: boolean; aliases?: string[]; hint?: string; producer?: string[] }>;
      }>;
    };
    expect(data.count).toBe(29);
    const design = data.skills.find((s) => s.skillId === 'design_course_structure')!;
    expect(design.required).toEqual(['graph', 'objectives']);
    const graphInput = design.inputs.find((i) => i.name === 'graph')!;
    expect(graphInput.aliases).toContain('knowledgeGraph');
    expect(graphInput.producer).toContain('extract_knowledge_graph');
    expect(design.usage).toContain('知识图谱');
    const parse = data.skills.find((s) => s.skillId === 'parse_course_material')!;
    expect(parse.inputs.some((i) => i.name === 'async' && i.required === false)).toBe(true);
  });

  it('按 skillId 过滤；未知技能返回 unavailable 并列出可用 id', async () => {
    const one = await adapter.invokeSkill('describe_capabilities', {
      inputs: { skillId: 'manage_course_assets' },
    });
    expect(one.level).toBe('full');
    const data = one.data as { count: number; skills: Array<{ skillId: string }> };
    expect(data.count).toBe(1);
    expect(data.skills[0].skillId).toBe('manage_course_assets');

    const missing = await adapter.invokeSkill('describe_capabilities', {
      inputs: { skillId: 'nope' },
    });
    expect(missing.level).toBe('unavailable');
    expect(missing.errorCode).toBe('INVALID_INPUT');
    expect(missing.degradationNote).toContain('describe_capabilities');
  });
});

describe('错误码体系（INVALID_INPUT + requiredInputs + example）', () => {
  it('缺失必填：带 errorCode/requiredInputs/example，message 仍含「输入校验失败」与引导', async () => {
    const r = await adapter.invokeSkill('extract_knowledge_graph', { inputs: {} });
    expect(r.level).toBe('unavailable');
    expect(r.errorCode).toBe('INVALID_INPUT');
    expect(r.requiredInputs).toContain('structuredContent');
    expect(r.example).toContain('structuredContent');
    expect(r.degradationNote).toContain('输入校验失败');
    expect(r.degradationNote).toContain('parse_course_material');
  });

  it('JSON 字符串解析失败：INVALID_INPUT 且给出期望形态', async () => {
    const r = await adapter.invokeSkill('extract_knowledge_graph', {
      inputs: { structuredContent: 'parse 输出' }, // 非 JSON 字符串
    });
    expect(r.level).toBe('unavailable');
    expect(r.errorCode).toBe('INVALID_INPUT');
    expect(r.degradationNote).toContain('解析失败');
    expect(r.degradationNote).toContain('parse_course_material');
  });

  it('执行异常：INTERNAL_ERROR（区别于输入校验，附 stack 摘要）', async () => {
    // materialFile 类型校验为 any（兼容多种形态），传数字会在执行层抛错 → 应标 INTERNAL_ERROR
    const r = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: 42 as never },
    });
    expect(r.level).toBe('unavailable');
    expect(r.errorCode).toBe('INTERNAL_ERROR');
    expect(r.degradationNote).toContain('内部错误');
  });

  it('core 层自检返回的 unavailable 也带 errorCode（可程序化分支）', async () => {
    const r = await adapter.invokeSkill('diff_knowledge_graphs', {
      inputs: { graphA: { foo: 1 } as never, graphB: { foo: 2 } as never },
    });
    expect(r.level).toBe('unavailable');
    expect(r.errorCode).toBe('INVALID_INPUT');
  });
});
