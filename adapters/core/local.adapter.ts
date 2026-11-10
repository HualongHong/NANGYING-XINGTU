/**
 * 本地自托管参考适配器。
 * 说明：这不是"第五平台"，而是 server 与测试使用的自托管参考实现——
 * 全部共享能力可用、特化能力全缺（特化技能待外部引擎接入后另行注册）。
 * LLM 来源：显式注入优先，缺省回退 .env / secrets.json（createLlmFromEnv）。
 */
import { AdapterBase } from './adapter.base.js';
import { registerSharedSkills } from './executors.js';
import { createLlmFromEnv } from './llmFromEnv.js';
import type { LLMProvider } from '../../core/llm.js';
import type { CapabilityProfile } from '../../core/types.js';

export class LocalAdapter extends AdapterBase {
  constructor(opts: { llm?: LLMProvider; envLlm?: boolean } = {}) {
    super();
    // LLM 来源：显式注入优先；缺省回退 .env / secrets.json（createLlmFromEnv）。
    // envLlm=false 时跳过 .env 回退（server 通道默认：宿主未注入则走启发式，避免大材料
    // 经 MCP 超时通道触发数十批同步 LLM 调用）；测试进程（VITEST）也不自动加载。
    const llm = opts.llm ??
      (opts.envLlm === false || process.env.VITEST ? undefined : createLlmFromEnv());
    const llmBatch = {
      concurrency: Number(process.env.NANGYING_LLM_CONCURRENCY ?? 4) || 4,
      budgetMs: Number(process.env.NANGYING_LLM_BUDGET_MS ?? 12 * 60_000) || 12 * 60_000,
    };
    registerSharedSkills(this, llm ? { llm, llmBatch } : { llmBatch });
  }

  /** 本地自托管档案：纯逻辑能力 confirmed，外部引擎类 false（降级实现） */
  getProfile() {
    const entry = (value: boolean | 'optional', confidence: 'confirmed' | 'inferred', note?: string) =>
      ({ value, confidence, ...(note ? { note } : {}) });
    return {
      platform: 'local',
      capabilities: {
        graph: entry(true, 'confirmed', 'core/graph 纯逻辑本地全量可用'),
        multilingual: entry(true, 'confirmed', '术语库 + 宿主 LLM 可选注入'),
        digitalHuman: entry(false, 'confirmed', '无外部引擎，特化技能走降级实现'),
        tts: entry(false, 'confirmed', '无 TTS 引擎，降级为纯字幕'),
        realtime: entry(false, 'confirmed', '无实时通道，降级为异步问答'),
        video: entry(false, 'confirmed', '无视频合成，降级为制作清单'),
      },
      llm: entry(true, 'inferred', '宿主可注入；缺省回退 .env/secrets；本地启发式路径不依赖 LLM'),
      streaming: entry(false, 'confirmed', 'stdio/HTTP JSON-RPC 无流式'),
      notes: '本地自托管参考实现：共享技能全量可用，特化技能为降级实现。',
    };
  }

  getCapabilities(): CapabilityProfile {
    return {
      platform: 'local',
      // 共享技能依赖（llm 为可选增强，缺省时 core 走启发式降级）
      available: ['documentParser', 'llm', 'ner', 'mtEngine', 'terminologyBase', 'vectorRetrieval'],
      degradationPlan: {},
    };
  }
}
