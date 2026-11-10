/**
 * 问答库构建（build_qa_knowledge_base）——N2 切片。
 *
 * 输入：课程知识图谱 + 原始段落（parse_course_material 输出）。
 * 输出：问答对数组 + 倒排检索索引 + 意图标签枚举 + search() 纯函数。
 *
 * 启发式默认：按概念节点生成模板问答（定义型/关系型）+ 流程型段落问答；
 * 检索为关键词倒排（契约降级即此实现；向量检索仅留接口注释钩子）。
 * LLM 注入时以段落改写生成更自然的问答；失败回落模板问答并标 degraded。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import type { CourseKnowledgeGraph, KnowledgeGraphEdge } from '../graph/extractKnowledgeGraph.js';
import type { ParsedParagraph } from '../nlp/parseCourseMaterial.js';

export const BUILD_QA_KNOWLEDGE_BASE_ID = 'build_qa_knowledge_base';

/** 输入：图谱 + 原始段落（teachingScript 的角色由段落语料承担，见契约出入点） */
export interface BuildQaInput {
  graph: CourseKnowledgeGraph;
  paragraphs: ParsedParagraph[];
}

/** 意图标签体系 */
export type IntentLabel = 'concept_definition' | 'concept_relation' | 'procedure';

export interface QaPair {
  id: string;
  question: string;
  answer: string;
  intent: IntentLabel;
  conceptIds: string[];
  /** 答案来源段落序号（-1 表示无直接来源） */
  sourceParagraph: number;
}

export interface InvertedIndexEntry {
  qaId: string;
  weight: number;
}

export interface RetrievalIndex {
  type: 'inverted';
  /** term（规范化小写） -> 命中问答对及权重 */
  terms: Record<string, InvertedIndexEntry[]>;
}

export interface QaKnowledgeBase {
  qaPairs: QaPair[];
  retrievalIndex: RetrievalIndex;
  intentLabels: IntentLabel[];
}

// 向量检索钩子：未来由宿主注入向量检索 provider 时替换/增强检索实现
// （如 interface VectorRetrievalProvider { embed(text): Promise<number[]> }），
// 当前版本仅实现契约降级路径——关键词倒排索引。

// ---------- 确定性 ID 与分词 ----------

function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** 检索分词：中文 2-4 字 n-gram + 英文单词（小写） */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const run of text.matchAll(/[一-鿿]+/g)) {
    const s = run[0];
    for (let n = 2; n <= Math.min(4, s.length); n++) {
      for (let i = 0; i + n <= s.length; i++) tokens.push(s.slice(i, i + n));
    }
  }
  for (const m of text.matchAll(/[A-Za-z][A-Za-z-]{1,}/g)) {
    tokens.push(m[0].toLowerCase());
  }
  return tokens;
}

// ---------- 检索 ----------

/** 关键词倒排检索：分词 → 倒排 → 权重求和排序（确定性 tie-break） */
export function search(kb: QaKnowledgeBase, query: string, topK = 5): QaPair[] {
  const tokens = tokenize(query);
  const scores = new Map<string, number>();
  for (const t of new Set(tokens)) {
    for (const hit of kb.retrievalIndex.terms[t] ?? []) {
      scores.set(hit.qaId, (scores.get(hit.qaId) ?? 0) + hit.weight);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topK)
    .map(([qaId]) => kb.qaPairs.find((q) => q.id === qaId)!)
    .filter(Boolean);
}

function buildIndex(qaPairs: QaPair[]): RetrievalIndex {
  const terms = new Map<string, Map<string, number>>();
  for (const qa of qaPairs) {
    const counts = new Map<string, number>();
    for (const t of tokenize(`${qa.question} ${qa.answer}`)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const [t, c] of counts) {
      const bucket = terms.get(t) ?? new Map<string, number>();
      bucket.set(qa.id, c);
      terms.set(t, bucket);
    }
  }
  return {
    type: 'inverted',
    terms: Object.fromEntries(
      [...terms.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([t, bucket]) => [
          t,
          [...bucket.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([qaId, weight]) => ({ qaId, weight })),
        ]),
    ),
  };
}

// ---------- 启发式模板问答 ----------

function findParagraphOf(label: string, paragraphs: ParsedParagraph[]): number {
  return paragraphs.findIndex((p) => p.text.includes(label));
}

function templatePairs(input: BuildQaInput): QaPair[] {
  const { graph, paragraphs } = input;
  const pairs: QaPair[] = [];
  const conceptById = new Map(graph.entities.map((e) => [e.id, e]));
  let seq = 0;
  const push = (p: Omit<QaPair, 'id'>) => {
    pairs.push({ ...p, id: `qa-${stableHash(`qa:${seq++}:${p.question}`)}` });
  };

  // 定义型：每个概念一条
  for (const entity of graph.entities) {
    const paraIdx = findParagraphOf(entity.label, paragraphs);
    push({
      question: `什么是${entity.label}？`,
      answer: paraIdx >= 0
        ? paragraphs[paraIdx].text
        : `${entity.label}是本课程的核心概念，详见课程对应章节。`,
      intent: 'concept_definition',
      conceptIds: [entity.id],
      sourceParagraph: paraIdx,
    });
  }

  // 关系型：概念间 related / prerequisite 边
  const conceptEdges = graph.relations.filter(
    (e): e is KnowledgeGraphEdge =>
      (e.type === 'related' || e.type === 'prerequisite') &&
      e.from.startsWith('con-') &&
      e.to.startsWith('con-'),
  );
  for (const edge of conceptEdges) {
    const a = conceptById.get(edge.from);
    const b = conceptById.get(edge.to);
    if (!a || !b) continue;
    const answer = edge.type === 'prerequisite'
      ? `${a.label}是${b.label}的先修知识，学习${b.label}之前应先掌握${a.label}。`
      : `${a.label}与${b.label}在课程内容中多次共同出现，学习时可对照理解两者的联系。`;
    push({
      question: `${a.label}和${b.label}有什么关系？`,
      answer,
      intent: 'concept_relation',
      conceptIds: [a.id, b.id],
      sourceParagraph: -1,
    });
  }

  // 流程型：含顺序标记的段落
  for (const para of paragraphs) {
    if (!/首先|然后|接着|最后|步骤/.test(para.text)) continue;
    push({
      question: `第${para.index + 1}段描述的流程是什么？`,
      answer: para.text,
      intent: 'procedure',
      conceptIds: [],
      sourceParagraph: para.index,
    });
  }

  return pairs;
}

// ---------- LLM 增强 ----------

interface LlmQa {
  question: string;
  answer: string;
  concepts?: string[];
}

async function llmPairs(
  input: BuildQaInput,
  ctx: SkillContext,
): Promise<{ pairs: QaPair[] | null; note: string }> {
  if (!ctx.llm || input.paragraphs.length === 0) return { pairs: null, note: '' };
  const corpus = input.paragraphs.slice(0, 10);
  const labels = input.graph.entities.map((e) => e.label);
  const prompt = [
    '你是课程问答整理助手。请根据以下课程段落生成自然的问答对（JSON 数组）：',
    JSON.stringify(corpus.map((p) => p.text)),
    labels.length > 0 ? `课程知识点（可用于 concepts 字段）：${JSON.stringify(labels)}` : '',
    '元素格式：{"question":"…","answer":"…","concepts":["知识点label",…]}。',
    '数组长度与段落数一致，每段至少一条。只输出 JSON 数组本身。',
  ].filter(Boolean).join('\n');
  try {
    const raw = (await ctx.llm.complete(prompt, { temperature: 0.4 })).trim();
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
    const idOf = new Map(input.graph.entities.map((e) => [e.label, e.id]));
    const pairs: QaPair[] = [];
    parsed.forEach((item: unknown, i: number) => {
      const q = item as LlmQa;
      if (typeof q?.question !== 'string' || typeof q?.answer !== 'string') return;
      const conceptIds = (Array.isArray(q.concepts) ? q.concepts : [])
        .filter((c): c is string => typeof c === 'string')
        .map((c) => idOf.get(c))
        .filter((c): c is string => Boolean(c));
      pairs.push({
        id: `qa-${stableHash(`qa:llm:${i}:${q.question}`)}`,
        question: q.question,
        answer: q.answer,
        intent: 'concept_definition',
        conceptIds,
        sourceParagraph: corpus[i]?.index ?? -1,
      });
    });
    if (pairs.length === 0) throw new Error('LLM 未返回有效问答');
    return { pairs, note: '' };
  } catch {
    return { pairs: null, note: 'LLM 问答生成失败，已回落模板问答' };
  }
}

// ---------- 主入口 ----------

export async function buildQaKnowledgeBase(
  input: BuildQaInput,
  ctx: SkillContext = {},
): Promise<SkillResult<QaKnowledgeBase>> {
  if (input.graph.entities.length === 0 && input.paragraphs.length === 0) {
    return {
      skillId: BUILD_QA_KNOWLEDGE_BASE_ID,
      level: 'degraded',
      data: { qaPairs: [], retrievalIndex: { type: 'inverted', terms: {} }, intentLabels: ['concept_definition', 'concept_relation', 'procedure'] },
      degradationNote: '图谱与段落均为空，仅返回空问答库骨架',
    };
  }

  const enhanced = await llmPairs(input, ctx);
  const qaPairs = enhanced.pairs ?? templatePairs(input);
  const kb: QaKnowledgeBase = {
    qaPairs,
    retrievalIndex: buildIndex(qaPairs),
    intentLabels: ['concept_definition', 'concept_relation', 'procedure'],
  };

  return {
    skillId: BUILD_QA_KNOWLEDGE_BASE_ID,
    level: enhanced.note ? 'degraded' : 'full',
    data: kb,
    degradationNote: enhanced.note,
  };
}
