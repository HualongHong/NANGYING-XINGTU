/**
 * 术语库模块（core/i18n）——translate_multilingual 的术语一致性技术落点。
 * 纯内存实现，零 Node API；导入/导出走 JSON 字符串（fs 归适配层）。
 * 全部输出确定性：条目始终按 term 排序。
 */

/** 语种代码：至少 zh/en，结构预留 ru/fr/ko 及任意扩展 */
export type LangCode = 'zh' | 'en' | 'ru' | 'fr' | 'ko' | (string & {});

/** 术语条目 */
export interface GlossaryEntry {
  /** 主术语（源语形式） */
  term: string;
  /** 主术语语种 */
  lang: LangCode;
  /** 各语种规范译法 */
  translations: Partial<Record<LangCode, string>>;
  /** 领域（可选，如 "machine-learning"） */
  domain?: string;
  /** 备注（可选） */
  note?: string;
}

export interface Glossary {
  entries: GlossaryEntry[];
}

/** 规范化：全角转半角、去首尾空白、拉丁字母小写（用于命中比较，不做替换） */
export function normalizeTerm(s: string): string {
  let out = '';
  for (const ch of s.trim()) {
    const code = ch.codePointAt(0)!;
    // 全角 ASCII 区（含全角空格）转半角
    if (code === 0x3000) {
      out += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - 0xfee0);
    } else {
      out += ch;
    }
  }
  return out.toLowerCase();
}

function sortEntries(entries: GlossaryEntry[]): GlossaryEntry[] {
  return [...entries].sort((a, b) => a.term.localeCompare(b.term, 'zh'));
}

export function createGlossary(entries: GlossaryEntry[] = []): Glossary {
  return { entries: sortEntries(entries) };
}

/** 添加/更新术语（同 term 视为更新），返回新词表 */
export function upsertTerm(glossary: Glossary, entry: GlossaryEntry): Glossary {
  const rest = glossary.entries.filter((e) => e.term !== entry.term);
  return { entries: sortEntries([...rest, entry]) };
}

export function removeTerm(glossary: Glossary, term: string): Glossary {
  return { entries: glossary.entries.filter((e) => e.term !== term) };
}

/** 导出为确定性 JSON 字符串（按 term 排序，两空格缩进） */
export function exportGlossary(glossary: Glossary): string {
  return JSON.stringify({ entries: sortEntries(glossary.entries) }, null, 2);
}

/** 从 JSON 字符串导入（校验最小结构，输出排序） */
export function importGlossary(json: string): Glossary {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Glossary).entries)) {
    throw new Error('术语库 JSON 结构非法：缺少 entries 数组');
  }
  for (const e of (parsed as Glossary).entries) {
    if (typeof e.term !== 'string' || typeof e.lang !== 'string' ||
        typeof e.translations !== 'object' || e.translations === null) {
      throw new Error('术语条目缺少 term/lang/translations 字段');
    }
  }
  return { entries: sortEntries((parsed as Glossary).entries) };
}

// ---------- 术语一致性强制 ----------

/** 文本中一次术语命中 */
export interface TermHit {
  entry: GlossaryEntry;
  /** 原文中被命中的文本 */
  matchedText: string;
  start: number;
  end: number;
}

/** 在文本中查找术语命中（规范化比较；按最长优先、从左到右不重叠切分） */
export function findTermHits(text: string, glossary: Glossary): TermHit[] {
  interface Form {
    entry: GlossaryEntry;
    raw: string;
    norm: string;
  }
  const forms: Form[] = [];
  for (const entry of glossary.entries) {
    forms.push({ entry, raw: entry.term, norm: normalizeTerm(entry.term) });
    for (const t of Object.values(entry.translations)) {
      if (t && normalizeTerm(t) !== normalizeTerm(entry.term)) {
        forms.push({ entry, raw: t, norm: normalizeTerm(t) });
      }
    }
  }
  // 长形式优先，避免"梯度下降"截断"随机梯度下降"
  const byNorm = new Map<string, Form>();
  for (const f of forms.sort((a, b) => b.norm.length - a.norm.length)) {
    if (!byNorm.has(f.norm)) byNorm.set(f.norm, f);
  }

  const hits: TermHit[] = [];
  const normText = normalizeTerm(text);
  let i = 0;
  while (i < normText.length) {
    let hit: Form | null = null;
    for (const f of byNorm.values()) {
      if (normText.startsWith(f.norm, i)) {
        hit = f;
        break;
      }
    }
    if (hit) {
      hits.push({ entry: hit.entry, matchedText: text.slice(i, i + hit.norm.length), start: i, end: i + hit.norm.length });
      i += hit.norm.length;
    } else {
      i += 1;
    }
  }
  return hits;
}

export interface TermEnforcementItem {
  term: string;
  targetLang: LangCode;
  /** 词表规范译法 */
  expected: string;
  /** 原文中实际命中文本 */
  matchedText: string;
  /** kept=已是规范译法；replaced=被强制替换 */
  action: 'kept' | 'replaced';
}

export interface TermEnforcementResult {
  text: string;
  items: TermEnforcementItem[];
}

/**
 * 术语一致性强制：把文本中命中的术语统一替换为目标语规范译法。
 * 命中比较做规范化（大小写/全半角）；已是规范译法的记 kept，其余替换并记 replaced。
 */
export function enforceTerminology(
  text: string,
  glossary: Glossary,
  targetLang: LangCode,
): TermEnforcementResult {
  const hits = findTermHits(text, glossary);
  const items: TermEnforcementItem[] = [];
  // 从后往前替换，保持偏移稳定
  let out = text;
  for (const hit of [...hits].sort((a, b) => b.start - a.start)) {
    const expected = hit.entry.translations[targetLang];
    if (!expected) continue; // 词表无目标语译法，不处理
    const action: TermEnforcementItem['action'] =
      normalizeTerm(hit.matchedText) === normalizeTerm(expected) ? 'kept' : 'replaced';
    items.push({
      term: hit.entry.term,
      targetLang,
      expected,
      matchedText: hit.matchedText,
      action,
    });
    if (action === 'replaced') {
      out = out.slice(0, hit.start) + expected + out.slice(hit.end);
    }
  }
  items.reverse(); // 恢复文本顺序
  return { text: out, items };
}
