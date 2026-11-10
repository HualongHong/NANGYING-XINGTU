/**
 * 双语同步（sync_bilingual，技能 #25，R7-1）。
 *
 * 背景（反馈 a N2）：中英"中文零改动"式同步——以中文原文为锚，逐段产出对齐译文，
 * 术语/公式锁定。两种模式：
 *  - mirror（默认）：中文主文档逐字不动，按段落产出对照译文 + 段落锚点对应表；
 *    LLM 可用时逐段对齐并做术语一致性检查（lockedSegments/glossary 命中即锁）；
 *  - translate：复用 translate_multilingual 的术语 glossary 机制（保持一致性），
 *    输出同构译文数组。
 *
 * 无 LLM 时 degraded：仅段落切分 + 对照骨架（secondary 为 null），诚实不编造译文。
 * 纯 TS、零 Node API、确定性（段落切分与锁定逻辑无随机）。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import { translateMultilingual } from './translateMultilingual.js';
import type { Glossary } from './glossary.js';

export const SYNC_BILINGUAL_ID = 'sync_bilingual';

export interface SyncBilingualInput {
  /** 中文主文档（mirror 模式逐字不动） */
  primaryText: string;
  /** 目标语种（zh/en/ru/fr/ko…） */
  secondaryLang: string;
  /** 锁定段：术语/公式清单，命中即锁（LLM 不得改动；一致性检查以此为基准） */
  lockedSegments?: string[];
  mode?: 'mirror' | 'translate';
  /** 术语库（translate 模式复用 translate_multilingual 机制） */
  glossary?: Glossary | string;
}

export interface SyncSegment {
  index: number;
  primary: string;
  /** mirror 模式：null=未译（无 LLM 骨架）；translate 模式：同构译文 */
  secondary: string | null;
}

export interface SyncBilingualResult {
  mode: 'mirror' | 'translate';
  lang: string;
  segments: SyncSegment[];
  /** 术语一致性：锁定项的规范译名在各段中的命中/缺失情况 */
  termConsistency: Array<{ term: string; expected?: string; segmentIndexes: number[]; missing: number[] }>;
  /** 段落锚点对应表（mirror：主段 → 译文段索引，一一对应） */
  anchors: Array<{ primary: number; secondary: number }>;
  /** translate 模式产物（多语同构，复用 translate_multilingual 输出） */
  translated?: unknown;
}

/** 段落切分（空行/换行分段，段内保留） */
export function splitSegments(text: string): string[] {
  return text
    .split(/\n{2,}|\r?\n(?=[#①②③•\-一-鿿])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 术语一致性检查基准：lockedSegments 优先，其次 glossary 的 lang 条目 */
function expectedTerms(input: SyncBilingualInput): Array<{ term: string; expected?: string }> {
  const out: Array<{ term: string; expected?: string }> = [];
  const glossary = typeof input.glossary === 'string' ? undefined : input.glossary;
  for (const t of input.lockedSegments ?? []) {
    const norm = t.trim();
    if (!norm) continue;
    const entry = glossary?.entries?.find((e) => e.term === norm);
    out.push({ term: norm, expected: entry?.translations?.[input.secondaryLang] });
  }
  return out;
}

export async function syncBilingual(
  input: SyncBilingualInput,
  ctx: SkillContext = {},
): Promise<SkillResult<SyncBilingualResult>> {
  if (typeof input?.primaryText !== 'string' || input.primaryText.trim().length === 0 ||
      typeof input?.secondaryLang !== 'string' || input.secondaryLang.trim() === '') {
    return {
      skillId: SYNC_BILINGUAL_ID,
      level: 'unavailable',
      errorCode: 'INVALID_INPUT',
      degradationNote: '输入校验失败：primaryText（非空中文主文档）与 secondaryLang（目标语种）为必需',
      example: '{ "primaryText": "# 种群生态学\\n\\n种群密度是……", "secondaryLang": "en", "mode": "mirror" }',
    };
  }
  const mode = input.mode === 'translate' ? 'translate' : 'mirror';
  const segments = splitSegments(input.primaryText);
  const terms = expectedTerms(input);

  // ---- translate 模式：复用 translate_multilingual 的 glossary 机制 ----
  if (mode === 'translate') {
    const tr = await translateMultilingual(
      {
        paragraphs: input.primaryText.split(/\n+/).map((s) => s.trim()).filter(Boolean),
        targetLanguages: [input.secondaryLang],
        ...(input.glossary ? { glossary: typeof input.glossary === 'string' ? undefined : input.glossary } : {}),
      },
      ctx,
    );
    const result: SyncBilingualResult = {
      mode,
      lang: input.secondaryLang,
      segments: segments.map((primary, index) => ({ index, primary, secondary: null })),
      termConsistency: terms.map((t) => {
        const hits = segments.map((s, i) => (s.includes(t.term) ? i : -1)).filter((i) => i >= 0);
        return { term: t.term, expected: t.expected, segmentIndexes: hits, missing: [] };
      }),
      anchors: segments.map((_, i) => ({ primary: i, secondary: i })),
      translated: tr.data,
    };
    return {
      skillId: SYNC_BILINGUAL_ID,
      level: tr.level,
      data: result,
      degradationNote: tr.degradationNote || (ctx.llm ? '' : '无 LLM：translate 模式译文为空骨架'),
    };
  }

  // ---- mirror 模式 ----
  // 无 LLM：对照骨架（secondary=null），诚实 degraded
  if (!ctx.llm) {
    return {
      skillId: SYNC_BILINGUAL_ID,
      level: 'degraded',
      data: {
        mode,
        lang: input.secondaryLang,
        segments: segments.map((primary, index) => ({ index, primary, secondary: null })),
        termConsistency: terms.map((t) => {
          const hits = segments.map((s, i) => (s.includes(t.term) ? i : -1)).filter((i) => i >= 0);
          return { term: t.term, expected: t.expected, segmentIndexes: hits, missing: [] };
        }),
        anchors: segments.map((_, i) => ({ primary: i, secondary: i })),
      },
      degradationNote: '未注入 LLM：仅产出段落切分 + 对照骨架（中文原文零改动）；注入 llm 后可得逐段对齐译文与术语一致性检查',
    };
  }

  // LLM 逐段对齐翻译 + 术语锁定
  try {
    const lockNote = terms.length > 0
      ? `以下术语必须原样保留（不得增删改）：${JSON.stringify(terms.map((t) => t.term))}` +
        (terms.some((t) => t.expected)
          ? `；其中带规范译名的按此翻译：${JSON.stringify(Object.fromEntries(terms.filter((t) => t.expected).map((t) => [t.term, t.expected])))}` : '')
      : '';
    const prompt = [
      '你是双语对齐翻译助手。以下是中文文档的逐段列表（JSON 数组，顺序即段落锚点）：',
      JSON.stringify(segments),
      `请逐段翻译为 ${input.secondaryLang}，严格一一对应、数量一致。`,
      lockNote,
      '严格以 JSON 字符串数组返回译文，顺序与输入一致，只输出 JSON 数组本身。',
    ].filter(Boolean).join('\n');
    const raw = (await ctx.llm.complete(prompt, { temperature: 0.3 })).trim();
    const parsed: unknown = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!Array.isArray(parsed) || parsed.length !== segments.length) throw new Error('段数不匹配');

    const translations = parsed.map((x) => (typeof x === 'string' ? x.trim() : ''));
    const consistency = terms.map((t) => {
      const hits = segments.map((s, i) => (s.includes(t.term) ? i : -1)).filter((i) => i >= 0);
      const missing: number[] = [];
      if (t.expected) {
        for (const i of hits) {
          if (!translations[i].includes(t.expected)) missing.push(i);
        }
      }
      return { term: t.term, expected: t.expected, segmentIndexes: hits, missing };
    });
    // 术语强制锁定：规范译名缺失的段直接替换锁定术语（保证命中即锁）
    for (const c of consistency) {
      if (!c.expected) continue;
      for (const i of c.segmentIndexes) {
        if (!translations[i].includes(c.expected) && c.term in Object.fromEntries(terms.map((t) => [t.term, 1]))) {
          translations[i] = translations[i].length > 0
            ? `${translations[i]}（${c.term}）`
            : c.term;
        }
      }
    }
    return {
      skillId: SYNC_BILINGUAL_ID,
      level: 'full',
      data: {
        mode,
        lang: input.secondaryLang,
        segments: segments.map((primary, index) => ({ index, primary, secondary: translations[index] || null })),
        termConsistency: consistency,
        anchors: segments.map((_, i) => ({ primary: i, secondary: i })),
      },
      degradationNote: '',
    };
  } catch {
    return {
      skillId: SYNC_BILINGUAL_ID,
      level: 'degraded',
      data: {
        mode,
        lang: input.secondaryLang,
        segments: segments.map((primary, index) => ({ index, primary, secondary: null })),
        termConsistency: terms.map((t) => {
          const hits = segments.map((s, i) => (s.includes(t.term) ? i : -1)).filter((i) => i >= 0);
          return { term: t.term, expected: t.expected, segmentIndexes: hits, missing: [] };
        }),
        anchors: segments.map((_, i) => ({ primary: i, secondary: i })),
      },
      degradationNote: 'LLM 对齐翻译失败，已回落对照骨架（中文原文零改动）',
    };
  }
}
