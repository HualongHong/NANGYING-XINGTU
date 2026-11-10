import { describe, expect, it } from 'vitest';
import { engineInfoOf, probeOcrEngine } from '../adapters/core/engineStatus.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

describe('R5-4 引擎状态三分（反馈 a P1-7，真实探测不硬编码）', () => {
  it('OCR 引擎：tesseract.js 已装且语言包在仓库根 → builtin', async () => {
    const info = await probeOcrEngine();
    expect(info.status).toBe('builtin');
    expect(info.detail).toContain('chi_sim');
  });

  it('特化技能：not-provided 且说明降级形态', async () => {
    const info = await engineInfoOf('synthesize_speech', '退化为纯字幕输出，无语音');
    expect(info!.status).toBe('not-provided');
    expect(info!.detail).toContain('纯字幕');
  });

  it('纯逻辑技能：无 engine 字段', async () => {
    expect(await engineInfoOf('fuse_knowledge_graphs', 'x')).toBeNull();
  });

  it('describe_capabilities 端到端：parse 带 engine，特化带降级说明，逻辑技能无 engine', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('describe_capabilities', { inputs: {} });
    const skills = (r.data as { skills: Array<{ skillId: string; engine?: { status: string; detail?: string } }> }).skills;
    const parse = skills.find((s) => s.skillId === 'parse_course_material')!;
    expect(parse.engine!.status).toBe('builtin');
    const dhv = skills.find((s) => s.skillId === 'generate_digital_human_video')!;
    expect(dhv.engine!.status).toBe('not-provided');
    expect(dhv.engine!.detail).toContain('降级');
    const fuse = skills.find((s) => s.skillId === 'fuse_knowledge_graphs')!;
    expect(fuse.engine).toBeUndefined();
  });
});
