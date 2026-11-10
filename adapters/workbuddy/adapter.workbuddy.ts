/**
 * workbuddy 平台适配器。能力档案见同目录 profile.json（保守默认，待平台方确认回填）；
 * 行为全部共享 adapters/core（platformAdapter 工厂 + AdapterBase 基类）。
 */
import { createPlatformAdapter } from '../core/platformAdapter.js';

export const WorkbuddyAdapter = createPlatformAdapter({
  platform: 'workbuddy',
  available: ['documentParser', 'llm', 'ner', 'vectorRetrieval'],
  degradationPlan: { mtEngine: 'degraded', digitalHumanModeling: 'degraded' },
});
