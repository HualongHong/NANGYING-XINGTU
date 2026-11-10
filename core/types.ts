/**
 * 囊萤星图共享类型定义。
 * 技能以 Markdown 描述文件 + JSON 注册表作为契约，本文件为适配层消费契约提供类型支撑。
 */

/** 技能描述符（对应 skills.registry.json 中每条记录） */
export interface SkillDescriptor {
  skillId: string;
  /** 中文名 */
  name: string;
  /** 类型：共享型（平台无关）或特化型（依赖外部引擎，可降级） */
  type: 'shared' | 'specialized';
  /** 一句话描述 */
  description: string;
  /** 输入参数名列表 */
  inputs: string[];
  /** 输出产物名列表 */
  outputs: string[];
  /** 外部依赖（如 llm、ttsEngine、vectorRetrieval），可为空数组 */
  dependsOn: string[];
  /** 降级策略描述 */
  degradation: string;
  /** 技能文档路径（skills/ 下的 md 文件） */
  docPath: string;
  /** 必填入参名列表（由契约「输入声明」段生成） */
  required?: string[];
  /** 入参规格（由契约「输入声明」段生成）：name 为契约真名 */
  inputSpecs?: Array<{
    name: string;
    kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'any';
    required: boolean;
    /** 兼容别名（执行器归一化时改写为 name） */
    aliases?: string[];
    /** 期望形态说明（中文，进错误消息与 schema description） */
    hint?: string;
    /** 上游技能（谁产出这个输入） */
    producer?: string[];
  }>;
  /** 别名 → 契约真名（inputSpecs 的扁平化，执行器归一化用） */
  aliases?: Record<string, string>;
  /** 一句话用法（describe_capabilities 输出） */
  usage?: string;
}

/** 能力档案：某平台/引擎当前可用能力集合 */
export interface CapabilityProfile {
  /** 平台标识，如 dsh、kimi、tare、codex */
  platform: string;
  /** 已确认可用的能力（对应技能 dependsOn 的依赖项） */
  available: string[];
  /** 能力缺失时的静态降级映射：依赖项 -> 降级等级 */
  degradationPlan?: Record<string, DegradationLevel>;
}

/** 降级等级 */
export type DegradationLevel = 'full' | 'degraded' | 'unavailable';

/** 技能调用统一返回结构 */
export interface SkillResult<T = unknown> {
  skillId: string;
  level: DegradationLevel;
  /** 正常产出物 */
  data?: T;
  /** 降级说明（触发降级时为中文描述，未降级为空串） */
  degradationNote: string;
  /** 错误码：INVALID_INPUT（入参缺失/类型错/解析失败）、INTERNAL_ERROR（执行异常）；成功结果不带 */
  errorCode?: 'INVALID_INPUT' | 'INTERNAL_ERROR';
  /** 缺失的必填入参名列表（INVALID_INPUT 时给出，便于调用方自愈） */
  requiredInputs?: string[];
  /** 最小入参示例（INVALID_INPUT 时给出） */
  example?: string;
}

// LLM 宿主注入点（定义见 core/llm.ts，此处 re-export 保持统一入口）
export type { LLMOptions, LLMProvider, SkillContext } from './llm.js';

// ---------- 适配器能力档案 ----------

/** 能力声明的置信度：confirmed（官方文档/实测）、inferred（公开资料推断）、unknown（待平台方确认） */
export type ProfileConfidence = 'confirmed' | 'inferred' | 'unknown';

export interface CapabilityEntry {
  value: boolean | 'optional';
  confidence: ProfileConfidence;
  note?: string;
}

/**
 * 适配器能力档案：描述宿主平台的真实能力，供适配层按能力启用/降级技能。
 * capabilities 键与 manifests/plugin.manifest.json 的 capabilities 对齐（graph/
 * multilingual/digitalHuman/tts/realtime）并扩展 video；逐项带置信度。
 */
export interface AdapterProfile {
  platform: string;
  capabilities: Record<string, CapabilityEntry>;
  /** 宿主 LLM 可用性（通常经宿主注入，不经插件密钥） */
  llm: CapabilityEntry;
  /** 流式输出/实时通道 */
  streaming: CapabilityEntry;
  notes?: string;
}
/** 保守默认能力档案：未知平台全量标 false/optional + unknown（适配器基类缺省返回） */
export function conservativeDefaultProfile(platform: string): AdapterProfile {
  const entry = (value: false | 'optional') => ({ value, confidence: 'unknown' as const });
  return {
    platform,
    capabilities: {
      graph: entry(false),
      multilingual: entry(false),
      digitalHuman: entry('optional'),
      tts: entry('optional'),
      realtime: entry('optional'),
      video: entry('optional'),
    },
    llm: entry(false),
    streaming: entry(false),
    notes: '保守默认：未确认能力一律按缺失处理，待平台适配器覆写',
  };
}
