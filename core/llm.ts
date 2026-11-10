/**
 * LLM 宿主注入点。
 * 插件自身不绑定任何 LLM 实现：由宿主 agent 注入 provider，
 * 技能函数通过可选的 SkillContext 接收。
 */

/** LLM 调用选项（各 provider 可扩展自有字段） */
export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

/** 宿主注入的大语言模型接口 */
export interface LLMProvider {
  complete(prompt: string, options?: LLMOptions): Promise<string>;
}

/** LLM 批处理配置（R5-2 并发池 + 进度回报 + 总预算兜底） */
export interface LlmBatchConfig {
  /** 并发批数（默认 4） */
  concurrency?: number;
  /** 总预算毫秒（默认 12 分钟；耗尽后未完成批次保留启发式候选） */
  budgetMs?: number;
  /** 进度回报（done/total/message） */
  onProgress?: (done: number, total: number, message: string) => void;
  /** 取消信号（async 作业经 AbortController 贯通） */
  signal?: AbortSignal;
}

/** 所有技能函数统一接收的可选上下文（宿主注入点） */
export interface SkillContext {
  /** 可选：注入后启用 LLM 增强路径；缺省时走启发式降级实现 */
  llm?: LLMProvider;
  /** 可选：文档解码器（宿主注入）；缺省时 parse 执行器回退到配置解码器或文本尽力提取 */
  decoder?: import('./decode/documentDecoder.js').DocumentDecoder;
  /** 可选：LLM 批并发/预算/进度配置（大材料术语过滤等批场景） */
  llmBatch?: LlmBatchConfig;
}
