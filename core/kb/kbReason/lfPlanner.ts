/**
 * LF 规划器（SPEC §4.6）：自然语言 → 逻辑式（LLM 只规划不执行）。
 * temperature 0 + schema 约束提示（算子手册由注册表自动生成）+ kb 统计摘要；
 * 返回原始 JSON 供 lfValidator 确定性校验——非法计划由调用方回落 retrieve。
 */
import type { LLMProvider } from '../../llm.js';
import type { TeachingKnowledgeBase } from '../kbTypes.js';
import { LF_OPERATORS } from './lfGrammar.js';

export interface LfPlanResult {
  ok: boolean;
  /** 解析出的逻辑式（ok 时给出；结构校验归 lfValidator） */
  plan?: unknown;
  /** 失败原因（LLM 异常/JSON 解析失败） */
  error?: string;
  /** 实际使用的提示词（审计/调试；调用方不必输出给终端用户） */
  prompt: string;
}

/** 构造规划提示词：算子手册（注册表驱动）+ kb 统计摘要 + few-shot */
export function buildPlannerPrompt(kb: TeachingKnowledgeBase, question: string): string {
  const manual = [...LF_OPERATORS.values()].map((op) => `- ${op.manual}`).join('\n');
  const sampleConcepts = kb.concepts.slice(0, 12).map((c) => `${c.id}=${c.label}`).join('、');
  return [
    '你是教学知识库的逻辑式规划器。把用户问题翻译成一个嵌套逻辑式（JSON：{ "op": 算子, "args": {...} }），只输出 JSON 本身，不要解释。',
    '可用算子（白名单，除此之外一律不得使用）：',
    manual,
    '规则：实体集在算子间流动；TRAVERSE 的 from、RETRIEVE 的 conceptIds、FILTER/SORT/COUNT 的 of 可以是嵌套逻辑式或 id 数组；嵌套不超过 3 层，算子总数不超过 8。',
    `知识库概况：概念 ${kb.stats.concepts} 个、证据 ${kb.stats.evidence} 条；示例概念：${sampleConcepts}。`,
    '示例：问"光反应的先修概念有哪些" → {"op":"TRAVERSE","args":{"from":{"op":"FIND","args":{"entity":"concept","where":{"labelContains":"光反应"}}},"edge":"prerequisite","direction":"in","depth":2}}',
    '示例：问"哪些概念还没有证据" → {"op":"GAP","args":{}}',
    `用户问题：${question}`,
  ].join('\n');
}

/** LLM 规划：自然语言 → LF JSON（不校验结构——校验归 lfValidator，职责分离） */
export async function planLogicalForm(
  kb: TeachingKnowledgeBase,
  question: string,
  llm: LLMProvider,
): Promise<LfPlanResult> {
  const prompt = buildPlannerPrompt(kb, question);
  try {
    const raw = (await llm.complete(prompt, { temperature: 0 })).trim();
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
    const plan: unknown = JSON.parse(cleaned);
    return { ok: true, plan, prompt };
  } catch (e) {
    return { ok: false, error: `LLM 规划失败：${e instanceof Error ? e.message : String(e)}`, prompt };
  }
}
