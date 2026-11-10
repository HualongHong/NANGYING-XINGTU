/**
 * 平台适配器工厂：一份声明（platform + 运行依赖清单 + 降级映射）生成一个平台适配器类。
 * profile.json 加载、保守回退、能力核对与降级阶梯全部共享 AdapterBase——
 * 新增/调整平台只需维护 adapters/<platform>/ 下的 profile.json 与本文件中的一份 spec。
 */
import { AdapterBase } from './adapter.base.js';
import {
  conservativeDefaultProfile,
  type AdapterProfile,
  type CapabilityProfile,
  type DegradationLevel,
} from '../../core/types.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** 平台接线声明：每个平台唯一需要维护的运行时数据 */
export interface PlatformAdapterSpec {
  /** 平台标识（须与 adapters/<platform>/profile.json 的 platform 字段一致） */
  platform: string;
  /** 宿主已确认可用的能力（对应技能契约的 dependsOn 依赖项） */
  available: readonly string[];
  /** 能力缺失时的静态降级映射：依赖项 -> 降级等级（缺省全部 degraded） */
  degradationPlan?: Record<string, DegradationLevel>;
}

/**
 * 由声明生成平台适配器类。profile.json 路径按 platform 集中解析
 * （adapters/<platform>/profile.json），文件缺失或结构非法时回退保守默认。
 */
export function createPlatformAdapter(spec: PlatformAdapterSpec): new () => AdapterBase {
  return class PlatformAdapter extends AdapterBase {
    getProfile(): AdapterProfile {
      const profilePath = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        spec.platform,
        'profile.json',
      );
      return this.loadProfileFile(profilePath) ?? conservativeDefaultProfile(spec.platform);
    }

    getCapabilities(): CapabilityProfile {
      return {
        platform: spec.platform,
        available: [...spec.available],
        degradationPlan: { ...spec.degradationPlan },
      };
    }
  };
}
