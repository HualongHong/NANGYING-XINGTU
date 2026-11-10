/**
 * kimi 平台适配器（覆盖 Kimi Code CLI 与 KimiWORK 宿主）。能力档案见同目录 profile.json；
 * 行为全部共享 adapters/core（platformAdapter 工厂 + AdapterBase 基类）。
 */
import { createPlatformAdapter } from '../core/platformAdapter.js';

export const KimiAdapter = createPlatformAdapter({
  platform: 'kimi',
  available: [
    'documentParser',
    'llm',
    'streamingApi',
    'mtEngine',
    'terminologyBase',
    'vectorRetrieval',
  ],
  degradationPlan: { realtimeChannel: 'degraded' },
});
