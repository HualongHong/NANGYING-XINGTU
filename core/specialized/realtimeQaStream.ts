/**
 * 实时问答流式交互（realtime_qa_stream）——N3 降级实现。
 *
 * 降级形态（契约）：异步问答——复用 build_qa_knowledge_base 的 search，
 * 输入问题 → topK 答案按置信度排序返回。
 * 流式/打断语义以"异步单轮"实现：一问一答，无增量输出与中断控制。
 * 实时通道/流式 API 留 provider 钩子（realtimeChannel/streamingApi）。
 */
import type { SkillResult } from '../types.js';
import { search, tokenize, type QaKnowledgeBase } from '../qa/buildQaKnowledgeBase.js';

export const REALTIME_QA_STREAM_ID = 'realtime_qa_stream';

// 真实引擎钩子：宿主可注入实时通道与流式生成 provider，
// 如 interface RealtimeChannelProvider { open(): Promise<Stream> }

export interface RealtimeQaInput {
  question: string;
  qaKnowledgeBase: QaKnowledgeBase;
  topK?: number;
}

export interface RankedAnswer {
  qaId: string;
  question: string;
  answer: string;
  /** 倒排命中得分（置信度代理） */
  score: number;
  conceptIds: string[];
}

export interface RealtimeQaOutput {
  mode: 'async-single-turn';
  question: string;
  answers: RankedAnswer[];
  /** 流式语义降级说明 */
  note: string;
}

export async function realtimeQaStream(
  input: RealtimeQaInput,
): Promise<SkillResult<RealtimeQaOutput>> {
  const { question, qaKnowledgeBase, topK = 3 } = input;
  // 复用问答库倒排检索（排序与打分口径一致，确定性）
  const ranked = search(qaKnowledgeBase, question, topK);
  const queryTokens = new Set(tokenize(question));
  const answers: RankedAnswer[] = ranked.map((qa, i) => {
    let score = 0;
    for (const t of queryTokens) {
      for (const hit of qaKnowledgeBase.retrievalIndex.terms[t] ?? []) {
        if (hit.qaId === qa.id) score += hit.weight;
      }
    }
    return {
      qaId: qa.id,
      question: qa.question,
      answer: qa.answer,
      // 中文查询词未命中倒排词项时，以排名倒序给确定性分值
      score: score > 0 ? score : topK - i,
      conceptIds: qa.conceptIds,
    };
  });
  return {
    skillId: REALTIME_QA_STREAM_ID,
    level: 'degraded',
    data: {
      mode: 'async-single-turn',
      question,
      answers,
      note: '实时通道/流式 API 未接入，降级为异步单轮问答（无增量输出与打断控制）',
    },
    degradationNote: '实时通道/流式 API 未接入，已降级为异步问答',
  };
}
