/**
 * codex 平台适配器。能力档案以同目录 profile.json 为准（loadProfileFile），
 * 加载失败回退保守默认（conservativeDefaultProfile）。
 */
import { AdapterBase } from '../core/adapter.base.js';
import { conservativeDefaultProfile, type CapabilityProfile, type AdapterProfile } from '../../core/types.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROFILE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'profile.json');

export class CodexAdapter extends AdapterBase {
  getProfile(): AdapterProfile {
    return this.loadProfileFile(PROFILE_PATH) ?? conservativeDefaultProfile('codex');
  }

  getCapabilities(): CapabilityProfile {
    return {
      platform: 'codex',
      available: ['documentParser', 'llm', 'mtEngine', 'terminologyBase', 'vectorRetrieval'],
      degradationPlan: {},
    };
  }
}
