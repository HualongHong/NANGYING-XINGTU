/**
 * dsh 平台适配器。能力档案以同目录 profile.json 为准（loadProfileFile），
 * 加载失败回退保守默认（conservativeDefaultProfile）。
 */
import { AdapterBase } from '../core/adapter.base.js';
import { conservativeDefaultProfile, type CapabilityProfile, type AdapterProfile } from '../../core/types.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROFILE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'profile.json');

export class DshAdapter extends AdapterBase {
  getProfile(): AdapterProfile {
    return this.loadProfileFile(PROFILE_PATH) ?? conservativeDefaultProfile('dsh');
  }

  getCapabilities(): CapabilityProfile {
    return {
      platform: 'dsh',
      available: ['documentParser', 'llm', 'ner', 'vectorRetrieval'],
      // 降级映射：契约依赖项 -> 降级等级
      degradationPlan: {mtEngine:"degraded",digitalHumanModeling:"degraded"},
    };
  }
}
