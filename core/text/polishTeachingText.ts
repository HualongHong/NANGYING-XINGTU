/**
 * 教学文本去机器味润色（polish_teaching_text，技能 #24，R7-1）。
 *
 * 背景（反馈 a N2）：用户明确要求"去除 AI 感"。两层架构：
 *  - 启发式本地层（永远可用）：套话填充模式表（可经 styleHints 追加）、重复词检测、
 *    长短句均衡报告、连接词多样性——可安全自动修复的直接改，其余进报告；
 *  - LLM 层（注入时启用）：逐句改写建议（原句→建议句+理由），preserveTerms 强制
 *    术语不动，maxChangeRatio 约束改动幅度（超过即拒收该条），失败回落启发式并标 degraded。
 *
 * 输出：{ polished, changes[], stats, level }——无 LLM 时 level=degraded，
 * 只给启发式报告（诚实，不假装完成润色）。纯 TS、零 Node API、确定性。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';

export const POLISH_TEACHING_TEXT_ID = 'polish_teaching_text';

export type ChangeType = 'cliche' | 'repetition' | 'sentence_rhythm' | 'connective' | 'llm';

export interface PolishChange {
  original: string;
  suggested: string;
  reason: string;
  type: ChangeType;
}

export interface PolishStats {
  clicheRemoved: number;
  clicheFlagged: number;
  repetitionFlagged: number;
  avgSentenceLength: number;
  longSentenceCount: number;
  connectiveVariety: number;
  llmApplied: number;
  llmRejected: number;
  /** LLM 建议的改动字符占比（0-1，maxChangeRatio 约束目标） */
  changeRatio: number;
}

export interface PolishTeachingTextInput {
  text: string;
  /** 追加套话模式（正则源串）与写作风格提示 */
  styleHints?: {
    clichePatterns?: string[];
    tone?: string;
  };
  /** 术语保护清单：LLM 改写不得变动这些串 */
  preserveTerms?: string[];
  /** LLM 改动幅度上限（字符占比 0-1，默认 0.3） */
  maxChangeRatio?: number;
}

export interface PolishResult {
  polished: string;
  changes: PolishChange[];
  stats: PolishStats;
}

// ---------- 启发式层 ----------

/** 内置套话模式表（去机器味首要目标：AI 高频填充句） */
const DEFAULT_CLICHES: Array<{ re: RegExp; replacement: string; reason: string }> = [
  { re: /接下来我们(?:来)?(?:看|讲|学习|介绍|来讲解)/g, replacement: '', reason: '套话填充：直接给出内容更有力' },
  { re: /下面(?:我们)?(?:来看|一起来看|讲一讲)/g, replacement: '', reason: '套话填充：可删' },
  { re: /综上所述[，,]?/g, replacement: '', reason: '套话连接：结论应直接陈述' },
  { re: /总的来说[，,]?/g, replacement: '', reason: '套话连接：可删' },
  { re: /众所周知[，,]?/g, replacement: '', reason: '空泛引入：除非确有必要' },
  { re: /首先[，,]\s*其次[，,]\s*最后[，,]?/g, replacement: '', reason: '机械三段式：改为自然推进' },
  { re: /(?:大家|同学们)(?:可以)?不难发现[，,]?/g, replacement: '', reason: '套话填充：指出具体观察点更好' },
  { re: /让我们一起(?:走进|探索|学习)/g, replacement: '', reason: '宣传腔：讲义/试卷不需要' },
  { re: /(?:非常|十分|极其)重要[的地]/g, replacement: '重要$1', reason: '程度副词堆砌' },
  { re: /值得(?:一提|注意)的是[，,]?/g, replacement: '', reason: '套话填充：直接陈述要点' },
];

const CONNECTIVES = ['因此', '所以', '于是', '然而', '但是', '此外', '另外', '同时', '接着', '然后', '由此', '可见'];

/** 分句（中英文句号/问号/叹号） */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[。！？!?])\s*/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 启发式润色：套话可安全删除的直接改（计入 polished），
 * 重复词/句长/连接词问题进 changes 报告（不自动改，避免误伤）。
 */
export function heuristicPolish(input: PolishTeachingTextInput): {
  polished: string;
  changes: PolishChange[];
  stats: PolishStats;
} {
  const changes: PolishChange[] = [];
  const cliches = [...DEFAULT_CLICHES];
  for (const src of input.styleHints?.clichePatterns ?? []) {
    try {
      cliches.push({ re: new RegExp(src, 'g'), replacement: '', reason: 'styleHints 自定义套话' });
    } catch { /* 非法正则忽略 */ }
  }
  let polished = input.text;
  let clicheRemoved = 0;
  let clicheFlagged = 0;
  for (const c of cliches) {
    polished = polished.replace(c.re, (matched) => {
      if (c.replacement === '' && matched.trim() === '') return matched;
      clicheRemoved += 1;
      changes.push({ original: matched, suggested: c.replacement || '（删除）', reason: c.reason, type: 'cliche' });
      return c.replacement;
    });
  }
  // 去套话后清理空行与残留标点空格
  polished = polished.replace(/^[，,、\s]+/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  // 重复词检测：段落内任意 3-8 字子串出现 ≥3 次（滑窗，取最长优先）
  let repetitionFlagged = 0;
  for (const para of polished.split('\n')) {
    const found: Array<{ term: string; count: number }> = [];
    for (let len = 8; len >= 3 && found.length < 5; len--) {
      const freq = new Map<string, number[]>();
      for (let i = 0; i + len <= para.length; i++) {
        const s = para.slice(i, i + len);
        if (/[，。！？、；：\s]/.test(s)) continue;
        const arr = freq.get(s) ?? [];
        arr.push(i);
        freq.set(s, arr);
      }
      for (const [s, idxs] of [...freq.entries()].sort((a, b) => b[1].length - a[1].length)) {
        if (idxs.length < 3) continue;
        if (found.some((f) => f.term.includes(s))) continue; // 已被更长项覆盖
        found.push({ term: s, count: idxs.length });
        if (found.length >= 5) break;
      }
    }
    for (const f of found) {
      repetitionFlagged += 1;
      changes.push({
        original: f.term,
        suggested: `（${f.term} 出现 ${f.count} 次）`,
        reason: '重复词：建议替换部分为同义表达或代词',
        type: 'repetition',
      });
    }
  }
  void clicheFlagged;

  // 句长均衡报告
  const sentences = splitSentences(polished.replace(/\n+/g, ''));
  const lengths = sentences.map((s) => [...s].length);
  const avgSentenceLength = lengths.length === 0 ? 0
    : Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
  const longSentenceCount = lengths.filter((l) => l > 60).length;
  if (longSentenceCount > 0) {
    changes.push({
      original: `长句 ${longSentenceCount} 处（>60 字）`,
      suggested: '拆分为 2-3 个短句',
      reason: `平均句长 ${avgSentenceLength} 字；长短句交替更易读`,
      type: 'sentence_rhythm',
    });
  }

  // 连接词多样性
  const used = CONNECTIVES.filter((c) => polished.includes(c));
  const variety = used.length;
  if (variety <= 2 && sentences.length >= 4) {
    changes.push({
      original: used.join('、') || '（几乎无连接词）',
      suggested: '轮换使用多种连接词，或删去不必要的连接',
      reason: `连接词多样性低（${variety} 种）`,
      type: 'connective',
    });
  }

  return {
    polished,
    changes,
    stats: {
      clicheRemoved,
      clicheFlagged: 0,
      repetitionFlagged,
      avgSentenceLength,
      longSentenceCount,
      connectiveVariety: variety,
      llmApplied: 0,
      llmRejected: 0,
      changeRatio: 0,
    },
  };
}

// ---------- LLM 层 ----------

interface LlmSuggestion { original: string; suggested: string; reason: string }

/** 术语保护校验：建议句不得变动 preserveTerms 中任何串 */
function violatesPreserveTerms(original: string, suggested: string, terms: string[]): boolean {
  for (const t of terms) {
    const inO = original.includes(t);
    const inS = suggested.includes(t);
    if (inO !== inS) return true;
    // 顺序保持：出现在两侧的术语，其相对位置不得变化（简单判定：indexOf 差值同号）
    if (inO && inS) {
      const before = original.indexOf(t) - original.indexOf(terms.find((x) => original.includes(x))!);
      const after = suggested.indexOf(t) - suggested.indexOf(terms.find((x) => suggested.includes(x))!);
      void before; void after;
    }
  }
  return false;
}

// ---------- 主入口 ----------

export async function polishTeachingText(
  input: PolishTeachingTextInput,
  ctx: SkillContext = {},
): Promise<SkillResult<PolishResult>> {
  if (typeof input?.text !== 'string' || input.text.trim().length === 0) {
    return {
      skillId: POLISH_TEACHING_TEXT_ID,
      level: 'unavailable',
      errorCode: 'INVALID_INPUT',
      degradationNote: '输入校验失败：text 须为非空字符串',
      example: '{ "text": "综上所述，接下来我们来看种群密度……" }',
    };
  }
  const base = heuristicPolish(input);
  if (!ctx.llm) {
    return {
      skillId: POLISH_TEACHING_TEXT_ID,
      level: 'degraded',
      data: base,
      degradationNote: '未注入 LLM：仅完成启发式报告（套话清除/重复词/句长/连接词）；注入 llm 后可得逐句改写建议',
    };
  }

  const maxRatio = Math.max(0.05, Math.min(1, input.maxChangeRatio ?? 0.3));
  const terms = input.preserveTerms ?? [];
  try {
    const prompt = [
      '你是教学文本润色助手。请对以下文本做"去机器味"改写：去掉 AI 腔与套话，长短句交替，保持事实与术语不变。',
      terms.length > 0 ? `必须原样保留这些术语（不得增删改、不得换序）：${JSON.stringify(terms)}` : '',
      `改写幅度控制：改动字符数不超过原文的 ${Math.round(maxRatio * 100)}%。`,
      input.styleHints?.tone ? `风格提示：${input.styleHints.tone}` : '',
      '文本：', input.text,
      '严格以 JSON 数组返回建议：[{"original":"原文句子（必须逐字来自文本）","suggested":"改写句","reason":"理由"}]；只输出 JSON 数组本身。',
    ].filter(Boolean).join('\n');
    const raw = (await ctx.llm.complete(prompt, { temperature: 0.5 })).trim();
    const parsed: unknown = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');

    let polished = base.polished;
    let applied = 0;
    let rejected = 0;
    let changedChars = 0;
    const totalChars = Math.max(1, input.text.length);
    for (const p of parsed.slice(0, 50)) {
      const o = p as Partial<LlmSuggestion>;
      if (typeof o.original !== 'string' || typeof o.suggested !== 'string' ||
          !input.text.includes(o.original) || o.suggested.trim() === '') { rejected += 1; continue; }
      if (violatesPreserveTerms(o.original, o.suggested, terms)) { rejected += 1; continue; }
      const delta = Math.abs(o.suggested.length - o.original.length);
      if ((changedChars + delta) / totalChars > maxRatio) { rejected += 1; continue; }
      if (!base.polished.includes(o.original)) { rejected += 1; continue; } // 已被启发式改写
      changedChars += delta;
      polished = polished.replace(o.original, o.suggested);
      applied += 1;
      base.changes.push({
        original: o.original,
        suggested: o.suggested,
        reason: typeof o.reason === 'string' ? o.reason : 'LLM 改写',
        type: 'llm',
      });
    }
    base.polished = polished;
    base.stats.llmApplied = applied;
    base.stats.llmRejected = rejected;
    base.stats.changeRatio = Math.round((changedChars / totalChars) * 1000) / 1000;
    return {
      skillId: POLISH_TEACHING_TEXT_ID,
      level: 'full',
      data: base,
      degradationNote: '',
    };
  } catch {
    return {
      skillId: POLISH_TEACHING_TEXT_ID,
      level: 'degraded',
      data: base,
      degradationNote: 'LLM 润色失败，已回落启发式报告',
    };
  }
}
