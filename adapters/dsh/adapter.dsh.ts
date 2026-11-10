/**
 * dsh 平台适配器。能力档案见同目录 profile.json；
 * 行为全部共享 adapters/core（platformAdapter 工厂 + AdapterBase 基类）。
 */
import { createPlatformAdapter } from '../core/platformAdapter.js';

export const DshAdapter = createPlatformAdapter({
  platform: 'dsh',
  available: ['documentParser', 'llm', 'ner', 'vectorRetrieval'],
  degradationPlan: { mtEngine: 'degraded', digitalHumanModeling: 'degraded' },
});
