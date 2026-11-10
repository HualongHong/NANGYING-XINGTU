/**
 * trae 平台适配器（字节跳动 Trae AI IDE）。能力档案见同目录 profile.json；
 * 行为全部共享 adapters/core（platformAdapter 工厂 + AdapterBase 基类）。
 */
import { createPlatformAdapter } from '../core/platformAdapter.js';

export const TraeAdapter = createPlatformAdapter({
  platform: 'trae',
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
