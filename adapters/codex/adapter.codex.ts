/**
 * codex 平台适配器（OpenAI Codex 编码 agent 宿主）。能力档案见同目录 profile.json；
 * 行为全部共享 adapters/core（platformAdapter 工厂 + AdapterBase 基类）。
 */
import { createPlatformAdapter } from '../core/platformAdapter.js';

export const CodexAdapter = createPlatformAdapter({
  platform: 'codex',
  available: ['documentParser', 'llm', 'mtEngine', 'terminologyBase', 'vectorRetrieval'],
});
