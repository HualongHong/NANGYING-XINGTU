/**
 * 适配器抽象基类。
 * 统一接口：registerSkill / invokeSkill / getCapabilities / fallback。
 * invokeSkill 先按能力档案检查技能依赖，缺失时沿 fallback 链逐级降级，
 * 返回带 DegradationLevel 的 SkillResult。
 */
import { createRequire } from 'node:module';
import { conservativeDefaultProfile } from '../../core/types.js';

const requireNodeFs = () => createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
import type {
  AdapterProfile,
  CapabilityProfile,
  DegradationLevel,
  SkillDescriptor,
  SkillResult,
} from '../../core/types.js';

export interface InvokeOptions {
  inputs: Record<string, unknown>;
  /** 进度回报（LLM 批等长任务；MCP 通道经 progress 通知推送） */
  onProgress?: (done: number, total: number, message: string) => void;
}

/** 执行函数签名：由具体适配器为每个技能提供实现 */
type SkillExecutor = (
  inputs: Record<string, unknown>,
  ctx: undefined,
  opts?: { onProgress?: InvokeOptions['onProgress'] },
) => Promise<unknown>;

export abstract class AdapterBase {
  /** 已注册技能表：skillId -> 描述符 */
  protected readonly skills = new Map<string, SkillDescriptor>();
  /** 已注册执行器表：skillId -> 执行函数 */
  protected readonly executors = new Map<string, SkillExecutor>();

  /** 注册技能（描述符 + 可选执行器） */
  registerSkill(descriptor: SkillDescriptor, executor?: SkillExecutor): void {
    this.skills.set(descriptor.skillId, descriptor);
    if (executor) {
      this.executors.set(descriptor.skillId, executor);
    }
  }

  /** 返回本平台能力档案（子类重写） */
  abstract getCapabilities(): CapabilityProfile;

  /** 已注册技能描述符只读列表（server / tools/list 使用） */
  listSkills(): SkillDescriptor[] {
    return [...this.skills.values()];
  }

  /**
   * 适配器能力档案：缺省返回保守默认（conservativeDefaultProfile），
   * 平台适配器重写为加载同目录 profile.json（loadProfileFile），加载失败回退保守默认。
   */
  getProfile(): AdapterProfile {
    return conservativeDefaultProfile(this.getCapabilities().platform);
  }

  /** 从 JSON 文件加载能力档案；文件缺失或结构非法返回 null（由调用方回退默认） */
  protected loadProfileFile(filePath: string): AdapterProfile | null {
    try {
      const { readFileSync } = requireNodeFs();
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as AdapterProfile;
      if (typeof parsed.platform !== 'string' || typeof parsed.capabilities !== 'object' ||
          parsed.capabilities === null || typeof parsed.llm !== 'object' ||
          typeof parsed.streaming !== 'object') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * 降级阶梯：按能力档案返回某技能在当前平台的降级等级。
   * full = 依赖齐备；degraded = 部分依赖缺失但可降级产出；unavailable = 无法产出。
   */
  fallback(skill: SkillDescriptor, profile: CapabilityProfile): DegradationLevel {
    const missing = skill.dependsOn.filter((dep) => !profile.available.includes(dep));
    if (missing.length === 0) return 'full';
    const plan = profile.degradationPlan ?? {};
    const levels = missing.map((dep) => plan[dep] ?? 'degraded');
    return levels.includes('unavailable') ? 'unavailable' : 'degraded';
  }

  /**
   * 调用技能：先查能力档案，缺能力时沿降级阶梯降级；
   * 降级仍产出（degraded），完全不可用（unavailable）时返回错误结果。
   */
  async invokeSkill<T = unknown>(
    skillId: string,
    options: InvokeOptions,
  ): Promise<SkillResult<T>> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return {
        skillId,
        level: 'unavailable',
        degradationNote: `技能 ${skillId} 未在本适配器注册`,
      };
    }

    const profile = this.getCapabilities();
    const level = this.fallback(skill, profile);

    if (level === 'unavailable') {
      return {
        skillId,
        level,
        degradationNote: `本平台缺少必需能力，技能 ${skillId} 不可用`,
      };
    }

    const executor = this.executors.get(skillId);
    if (!executor) {
      return {
        skillId,
        level: 'unavailable',
        degradationNote: `技能 ${skillId} 暂无执行器实现`,
      };
    }

    const data = (await executor(options.inputs, undefined, options)) as T;
    // 执行器返回完整 SkillResult 形态（含 skillId 与 level）时原样透回，
    // 保证 core 侧已标注的降级（如 parse 格式直通 degraded）不被能力档案覆盖
    if (
      typeof data === 'object' &&
      data !== null &&
      'skillId' in data &&
      'level' in data
    ) {
      return data as unknown as SkillResult<T>;
    }
    return {
      skillId,
      level,
      data,
      degradationNote: level === 'degraded' ? `已按降级策略执行：${skill.degradation}` : '',
    };
  }
}
