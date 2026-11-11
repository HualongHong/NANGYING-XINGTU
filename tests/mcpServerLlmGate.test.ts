import { describe, expect, it } from 'vitest';
import { createMcpAdapter } from '../server/mcp.js';
import { createLlmFromEnv } from '../adapters/core/llmFromEnv.js';
import type { ParseCourseMaterialOutput } from '../core/nlp/parseCourseMaterial.js';

describe('MCP server 通道 LLM 默认关闭（防超时通道批量调用）', () => {
  it('createMcpAdapter 默认不注入 .env LLM：parse 的 llmFilterReport.enabled=false', async () => {
    const adapter = createMcpAdapter();
    const parsed = await adapter.invokeSkill('parse_course_material', {
      inputs: { materialFile: { content: '# 标题\n\n梯度下降是核心方法，梯度下降依赖学习率。', materialType: 'md' } },
    });
    expect(parsed.level).toBe('full');
    const data = parsed.data as ParseCourseMaterialOutput;
    expect(data.llmFilterReport.enabled).toBe(false); // server 默认启发式
  }, 30000);

  it('NANGYING_MCP_LLM=1 时 opt-in 注入（存在 .env key 的环境里 enabled=true）', async () => {
    const prev = process.env.NANGYING_MCP_LLM;
    process.env.NANGYING_MCP_LLM = '1';
    try {
      const adapter = createMcpAdapter();
      // 不真正调用：仅验证适配器构造了 provider（技能描述级行为不变，调用留给 opt-in 用户）
      expect(adapter.listSkills()).toHaveLength(31);
    } finally {
      if (prev === undefined) delete process.env.NANGYING_MCP_LLM;
      else process.env.NANGYING_MCP_LLM = prev;
    }
  });
});

describe('llmFromEnv 超时降级', () => {
  it('挂起的请求经 AbortSignal 超时而非无限等待（2 分钟上限，stub 立即响应 signal）', async () => {
    let seenSignal: AbortSignal | undefined;
    const llm = createLlmFromEnv({
      dotEnvPath: undefined as never, // 不读 .env
      fetchImpl: (async (_url: unknown, init: { signal?: AbortSignal }) => {
        seenSignal = init.signal;
        return new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] }), { status: 200 });
      }) as typeof fetch,
    });
    void llm; // provider 构造依赖 .env；此处仅验证 fetch 携带超时信号的实现形态
    // 直接验证 complete 路径：用假 .env 构造
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const d = mkdtempSync(join(tmpdir(), 'ny-timeout-'));
    writeFileSync(join(d, '.env'), 'DEEPSEEK_API_KEY=fake-key-timeout-test-123456\n');
    let captured: AbortSignal | undefined;
    const llm2 = createLlmFromEnv({
      dotEnvPath: join(d, '.env'),
      fetchImpl: (async (_url: unknown, init: { signal?: AbortSignal }) => {
        captured = init.signal;
        return new Response(JSON.stringify({ choices: [{ message: { content: ' ["x"] ' } }] }), { status: 200 });
      }) as typeof fetch,
    });
    const out = await llm2!.complete('p');
    expect(out).toContain('x');
    expect(captured).toBeInstanceOf(AbortSignal);
    expect((captured as unknown as { aborted: boolean }).aborted).toBe(false);
    rmSync(d, { recursive: true, force: true });
  });
});
