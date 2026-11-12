import { describe, expect, it, vi } from 'vitest';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import { registerSharedSkills } from '../adapters/core/executors.js';
import type { LLMProvider } from '../core/llm.js';
import type { ParseCourseMaterialOutput } from '../core/nlp/parseCourseMaterial.js';
import type { TeachingScript } from '../core/course/generateTeachingScript.js';
import type { CourseStructure } from '../core/course/designCourseStructure.js';
import type { CourseKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';

const FIXTURE = 'tests/fixtures/sample-lecture-ml-basics.md';

async function runChain(adapter: LocalAdapter) {
  const parsed = await adapter.invokeSkill<ParseCourseMaterialOutput>('parse_course_material', {
    inputs: { materialFile: FIXTURE },
  });
  expect(parsed.level).toBe('full');
  expect(parsed.data!.paragraphs.length).toBeGreaterThan(15);

  const graph = await adapter.invokeSkill<CourseKnowledgeGraph>('extract_knowledge_graph', {
    inputs: { structuredContent: parsed.data },
  });
  expect(graph.level).toBe('full');
  expect(graph.data!.entities.length).toBeGreaterThan(5);

  const design = await adapter.invokeSkill<CourseStructure>('design_course_structure', {
    inputs: {
      graph: graph.data,
      objectives: { audience: '本科生', totalMinutes: 90 },
    },
  });
  expect(design.level).toBe('full');
  expect(design.data!.teachingStructure.length).toBeGreaterThan(0);

  const script = await adapter.invokeSkill<TeachingScript>('generate_teaching_script', {
    inputs: { structure: design.data },
  });
  expect(script.level).toBe('full');
  expect(script.data!.storyboardScript.length).toBeGreaterThan(0);
  return { parsed, graph, design, script };
}

describe('适配器接线（LocalAdapter）', () => {
  it('fixture 文件路径 → parse → extract → design → script 全链路', async () => {
    const adapter = new LocalAdapter();
    const { script } = await runChain(adapter);
    const scenes = script.data!.storyboardScript.flatMap((l) => l.scenes);
    expect(scenes.length).toBeGreaterThan(15);
  });

  it('未知技能返回 unavailable', async () => {
    const adapter = new LocalAdapter();
    const result = await adapter.invokeSkill('no_such_skill', { inputs: {} });
    expect(result.level).toBe('unavailable');
    expect(result.degradationNote).toContain('未在本适配器注册');
  });

  it('33 个技能全部注册（含导出、图谱运算、异步任务、能力自述、反馈协调、设置卡片、学术证据与数据集探查）', () => {
    const adapter = new LocalAdapter();
    const ids = adapter.listSkills().map((s) => s.skillId);
    expect(ids).toHaveLength(33);
    expect(ids).toContain('export_course_package');
    expect(ids).toContain('submit_feedback');
    expect(ids).toContain('settings_card');
    expect(ids).toContain('enrich_knowledge_evidence');
    expect(ids).toContain('inspect_teaching_dataset');
    expect(ids).toContain('realtime_qa_stream');
    expect(ids).toContain('fuse_knowledge_graphs');
    expect(ids).toContain('diff_knowledge_graphs');
    expect(ids).toContain('manage_async_tasks');
    expect(ids).toContain('describe_capabilities');
    expect(ids).toContain('generate_assessment');
    expect(ids).toContain('audit_consistency');
    expect(ids).toContain('polish_teaching_text');
    expect(ids).toContain('sync_bilingual');
    expect(ids).toContain('qa_media');
    expect(ids).toContain('render_preview');
    expect(ids).toContain('build_industry_graph');
    expect(ids).toContain('link_knowledge_industry');
  });

  it('未知 materialType 走 degraded 直通且数据可用（不被能力档案覆盖）', async () => {
    const adapter = new LocalAdapter();
    const result = await adapter.invokeSkill<ParseCourseMaterialOutput>('parse_course_material', {
      inputs: { materialFile: { content: '第一行\n第二行', materialType: 'weird-format' } },
    });
    expect(result.level).toBe('degraded');
    expect(result.degradationNote).toContain('纯文本提取');
    expect(result.data!.paragraphs).toHaveLength(2);
  });

  it('opts.llm 注入透传到 core（mock provider 被调用）', async () => {
    const complete = vi.fn<(prompt: string, options?: unknown) => Promise<string>>(
      async (prompt: string) => {
        const batch: string[] = JSON.parse(prompt.slice(prompt.lastIndexOf('[')));
        // mock 分类：梯度下降=term 保留，其余=noise 丢弃
        return JSON.stringify(batch.map((t) => ({
          term: t, cls: t === '梯度下降' ? 'term' : 'noise', reason: 'mock',
        })));
      },
    );
    const mockLlm: LLMProvider = { complete };
    const adapter = new LocalAdapter();
    registerSharedSkills(adapter, { llm: mockLlm });
    const parsed = await adapter.invokeSkill<ParseCourseMaterialOutput>('parse_course_material', {
      inputs: { materialFile: FIXTURE },
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const terms = parsed.data!.knowledgePointCandidates.map((c: { term: string }) => c.term);
    expect(terms).toEqual(['梯度下降']); // 仅 term 类保留，noise 类丢弃
  });

  it('已解码 { content, materialType } 输入直接透传', async () => {
    const adapter = new LocalAdapter();
    const result = await adapter.invokeSkill<ParseCourseMaterialOutput>('parse_course_material', {
      inputs: { materialFile: { content: '# 标题\n\n正文段落。', materialType: 'md' } },
    });
    expect(result.level).toBe('full');
    expect(result.data!.structuredSections[0].title).toBe('标题');
  });
});
