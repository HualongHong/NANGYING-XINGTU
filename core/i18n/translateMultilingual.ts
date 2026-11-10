/**
 * 多语种翻译（translate_multilingual）——N2 切片。
 *
 * 输入：教学脚本全稿（TeachingScript，逐 scene 翻译 voiceover/subtitle）
 * 或纯文本段落列表；目标语种列表；可选宿主注入 LLMProvider；可选术语库。
 *
 * 术语一致性：LLM 译文经词表强制校正（enforceTerminology），
 * 替换记录进入术语使用报告。
 *
 * 降级（无 LLM 注入）：正文保留原文，词表命中术语附目标语规范译法标注
 * （如"梯度下降（gradient descent）"），level 标 degraded——
 * 这是契约"仅中英"降级语义的实现侧约定（见技能 md 出入点说明）。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import type { TeachingScript } from '../course/generateTeachingScript.js';
import {
  createGlossary,
  enforceTerminology,
  findTermHits,
  type Glossary,
  type LangCode,
  type TermEnforcementItem,
} from './glossary.js';

export const TRANSLATE_MULTILINGUAL_ID = 'translate_multilingual';

/** 输入：教学脚本全稿或纯文本段落列表 */
export type TranslateInput =
  | { script: TeachingScript; targetLanguages: LangCode[]; glossary?: Glossary }
  | { paragraphs: string[]; targetLanguages: LangCode[]; glossary?: Glossary };

/** 翻译后的 scene：结构字段（id/时长/知识点 ID 等）原样保留，仅文本字段为译文 */
export interface TranslatedScene {
  id: string;
  lessonId: string;
  phase: string;
  sceneType: string;
  visual: string;
  voiceover: string;
  subtitle: string;
  minutes: number;
  startMinute: number;
  conceptIds: string[];
}

export interface TranslatedScript {
  storyboardScript: Array<{ lessonId: string; title: string; scenes: TranslatedScene[] }>;
  voiceoverScript: Array<{ lessonId: string; title: string; text: string }>;
  subtitleScript: Array<{ lessonId: string; sceneId: string; startMinute: number; minutes: number; text: string }>;
}

/** 单语种的术语强制记录 */
export interface TermEnforcementRecord extends TermEnforcementItem {
  lang: LangCode;
  /** 所在片段位置描述，如 scene:les-1:0 或 para:3 */
  location: string;
}

export interface TranslateOutput {
  /** 各语种同构产物（scene 文本字段为该语种译文，结构字段不动） */
  multilingualTexts: Array<{ lang: LangCode; script: TranslatedScript | string[] }>;
  /** 术语对照表（实际参与翻译的全部术语） */
  termGlossary: Glossary;
  /** 术语使用报告：哪些被强制替换、哪些已是规范译法 */
  termReport: TermEnforcementRecord[];
}

// ---------- 内部工具 ----------

type Segment = { kind: 'scene'; location: string; text: string } | { kind: 'para'; location: string; text: string };

function collectSegments(input: TranslateInput): Segment[] {
  if ('script' in input) {
    const segs: Segment[] = [];
    for (const lesson of input.script.storyboardScript) {
      lesson.scenes.forEach((scene, i) => {
        segs.push({ kind: 'scene', location: `scene:${scene.id}`, text: scene.voiceover });
        // 字幕与口播同源；逐 scene 两条记录，位置用副标题标记
        segs.push({ kind: 'scene', location: `subtitle:${scene.id}:${i}`, text: scene.subtitle });
      });
    }
    return segs;
  }
  return input.paragraphs.map((text, i) => ({ kind: 'para', location: `para:${i}`, text }));
}

function rebuildScript(
  source: TeachingScript,
  translated: Map<string, string>,
): TranslatedScript {
  const storyboardScript = source.storyboardScript.map((lesson) => ({
    lessonId: lesson.lessonId,
    title: lesson.title,
    scenes: lesson.scenes.map((scene, i) => ({
      id: scene.id,
      lessonId: scene.lessonId,
      phase: scene.phase,
      sceneType: scene.sceneType,
      visual: scene.visual,
      voiceover: translated.get(`scene:${scene.id}`) ?? scene.voiceover,
      subtitle: translated.get(`subtitle:${scene.id}:${i}`) ?? scene.subtitle,
      minutes: scene.minutes,
      startMinute: scene.startMinute,
      conceptIds: scene.conceptIds,
    })),
  }));
  const voiceoverScript = storyboardScript.map((lesson) => ({
    lessonId: lesson.lessonId,
    title: lesson.title,
    text: lesson.scenes.map((s) => s.voiceover).join('\n'),
  }));
  const subtitleScript = storyboardScript.flatMap((lesson) =>
    lesson.scenes.map((s) => ({
      lessonId: lesson.lessonId,
      sceneId: s.id,
      startMinute: s.startMinute,
      minutes: s.minutes,
      text: s.subtitle,
    })),
  );
  return { storyboardScript, voiceoverScript, subtitleScript };
}

/** 无 LLM 的降级标注：原文保留，词表命中术语附目标语规范译法 */
function annotateWithTerms(text: string, glossary: Glossary, targetLang: LangCode): string {
  const hits = findTermHits(text, glossary);
  let annotated = text;
  for (const hit of [...hits].sort((a, b) => b.start - a.start)) {
    const target = hit.entry.translations[targetLang];
    if (!target || hit.matchedText === target) continue;
    annotated = annotated.slice(0, hit.end) + `（${target}）` + annotated.slice(hit.end);
  }
  return annotated;
}

// ---------- 主入口 ----------

export async function translateMultilingual(
  input: TranslateInput,
  ctx: SkillContext = {},
): Promise<SkillResult<TranslateOutput>> {
  const { targetLanguages, glossary = createGlossary() } = input;
  if (targetLanguages.length === 0) {
    return {
      skillId: TRANSLATE_MULTILINGUAL_ID,
      level: 'degraded',
      data: { multilingualTexts: [], termGlossary: glossary, termReport: [] },
      degradationNote: '目标语种列表为空',
    };
  }

  const segments = collectSegments(input);
  if (segments.length === 0) {
    return {
      skillId: TRANSLATE_MULTILINGUAL_ID,
      level: 'degraded',
      data: { multilingualTexts: [], termGlossary: glossary, termReport: [] },
      degradationNote: '输入文本为空',
    };
  }

  const multilingualTexts: TranslateOutput['multilingualTexts'] = [];
  const termReport: TermEnforcementRecord[] = [];
  let level: 'full' | 'degraded' = 'full';
  const notes: string[] = [];

  for (const lang of targetLanguages) {
    const canonical = glossary.entries
      .map((e) => ({ zh: e.term, target: e.translations[lang] }))
      .filter((x): x is { zh: string; target: string } => Boolean(x.target));

    // 通用落位：产出译文 + 当次术语强制记录（报告必须在强制发生时采集，
    // 事后对已校正文本再跑 enforceTerminology 只会得到 kept）
    const apply = (
      produce: (text: string, index: number) => { text: string; items: TermEnforcementItem[] },
    ) => {
      const translated = new Map<string, string>();
      for (const [index, seg] of segments.entries()) {
        const r = produce(seg.text, index);
        translated.set(seg.location, r.text);
        for (const item of r.items) {
          termReport.push({ ...item, lang, location: seg.location });
        }
      }
      pushResult(input, lang, translated, multilingualTexts);
    };

    if (!ctx.llm) {
      // 降级路径：术语标注稿（原文保留，词表命中术语附目标语规范译法）
      apply((text) => ({ text: annotateWithTerms(text, glossary, lang), items: annotationItems(text, glossary, lang) }));
      notes.push(`语种 ${lang}：无翻译引擎，退化为术语标注稿`);
      level = 'degraded';
      continue;
    }

    // LLM 路径：一次调用翻译全部片段
    const prompt = [
      `你是课程讲稿翻译助手。请把以下 JSON 数组中的中文段落逐条翻译为${lang}。`,
      canonical.length > 0
        ? `术语必须使用如下规范译法：${canonical.map((c) => `${c.zh} → ${c.target}`).join('；')}。`
        : '',
      '严格以 JSON 字符串数组返回译文，顺序与输入一致，只输出 JSON 数组本身。',
      JSON.stringify(segments.map((s) => s.text)),
    ].filter(Boolean).join('\n');

    let texts: string[];
    try {
      const raw = (await ctx.llm.complete(prompt, { temperature: 0.3 })).trim();
      const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
      const parsed: unknown = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
      texts = parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
      if (texts.length !== segments.length) throw new Error('LLM 返回长度不匹配');
    } catch (err) {
      notes.push(`语种 ${lang}：LLM 翻译失败（${err instanceof Error ? err.message : String(err)}），退化为术语标注稿`);
      level = 'degraded';
      apply((text) => ({ text: annotateWithTerms(text, glossary, lang), items: annotationItems(text, glossary, lang) }));
      continue;
    }

    // LLM 译文经词表强制校正（替换记录进入术语使用报告）
    apply((_text, i) => enforceTerminology(texts[i], glossary, lang));
  }

  return {
    skillId: TRANSLATE_MULTILINGUAL_ID,
    level,
    data: { multilingualTexts, termGlossary: glossary, termReport },
    degradationNote: notes.join('；'),
  };
}

function pushResult(
  input: TranslateInput,
  lang: LangCode,
  translated: Map<string, string>,
  out: TranslateOutput['multilingualTexts'],
): void {
  if ('script' in input) {
    out.push({ lang, script: rebuildScript(input.script, translated) });
  } else {
    out.push({ lang, script: input.paragraphs.map((_, i) => translated.get(`para:${i}`) ?? '') });
  }
}

/** 降级标注的术语记录：被附注的命中统一记为 replaced（附注视为强制干预） */
function annotationItems(
  text: string,
  glossary: Glossary,
  targetLang: LangCode,
): TermEnforcementItem[] {
  const items: TermEnforcementItem[] = [];
  for (const hit of findTermHits(text, glossary)) {
    const target = hit.entry.translations[targetLang];
    if (!target || hit.matchedText === target) continue;
    items.push({
      term: hit.entry.term,
      targetLang,
      expected: target,
      matchedText: hit.matchedText,
      action: 'replaced',
    });
  }
  return items;
}
