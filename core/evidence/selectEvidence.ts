/**
 * 研究例证选文（select_research_evidence）核心：纯函数，零 IO。
 * 从 parse_abstract_collection 的结构化记录中，按章节知识点选研究例证：
 * 词族命中加权评分（方法论 3.5）、相对分位阈值（不用绝对分数线）、
 * 排除词降权、题名去重、覆盖面约束优先（每节至少 k 条，补入标「必复核」）、
 * 收敛四条件（3.7）与复核记录表（附录 F）。
 * 词族派生（同义/上下位/排除词）可由 ctx.llm 增强；缺 LLM 退化为核心词直取，不编造扩展词。
 */

export interface KnowledgeSectionInput {
  title?: unknown;
  knowledgePoints?: unknown;
  keyPoints?: unknown;
  confusables?: unknown;
  declaredNoHit?: unknown;
}

export interface KnowledgeSection {
  title: string;
  knowledgePoints: string[];
  keyPoints: string[];
  confusables: string[];
  /** 无可靠命中声明（方法论 K2：宁可留白注明以教材为准，不硬套） */
  declaredNoHit: boolean;
}

export interface TermFamily {
  section: string;
  core: string[];
  expansion: string[];
  exclusion: string[];
}

export interface FieldWeights {
  title: number;
  keyword: number;
  body: number;
  affiliation: number;
}

export const DEFAULT_WEIGHTS: FieldWeights = { title: 3, keyword: 2, body: 1, affiliation: 0.5 };
/** 相对分位默认值：仅建议值（方法论 3.5），不同摘要集规模/学科词频差异极大，须可配 */
export const DEFAULT_PERCENTILE = 0.2;
export const DEFAULT_PER_SECTION_MIN = 1;

export interface SelectEvidencePlan {
  ok: boolean;
  sections: KnowledgeSection[];
  weights: FieldWeights;
  percentile: number;
  perSectionMin: number;
  error?: string;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((s) => s.trim()) : [];
}

/** 入参校验：sections 与 records 必填；权重/分位/每节下限给安全缺省（建议值语义） */
export function planSelection(input: {
  sections?: unknown;
  weights?: unknown;
  percentile?: unknown;
  perSectionMin?: unknown;
}): SelectEvidencePlan {
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    return { ok: false, sections: [], weights: DEFAULT_WEIGHTS, percentile: DEFAULT_PERCENTILE, perSectionMin: DEFAULT_PER_SECTION_MIN, error: 'sections 必填：非空数组 [{ title, knowledgePoints, keyPoints?, confusables?, declaredNoHit? }]' };
  }
  const sections: KnowledgeSection[] = [];
  for (const [i, s] of (input.sections as KnowledgeSectionInput[]).entries()) {
    if (!isObj(s) || typeof s.title !== 'string' || !s.title.trim()) {
      return { ok: false, sections: [], weights: DEFAULT_WEIGHTS, percentile: DEFAULT_PERCENTILE, perSectionMin: DEFAULT_PER_SECTION_MIN, error: `sections[${i}].title 必填（节名，非空字符串）` };
    }
    sections.push({
      title: s.title.trim(),
      knowledgePoints: strArr(s.knowledgePoints),
      keyPoints: strArr(s.keyPoints).length > 0 ? strArr(s.keyPoints) : strArr(s.knowledgePoints),
      confusables: strArr(s.confusables),
      declaredNoHit: s.declaredNoHit === true,
    });
  }
  const weights: FieldWeights = { ...DEFAULT_WEIGHTS };
  if (input.weights !== undefined) {
    if (!isObj(input.weights)) return { ok: false, sections: [], weights: DEFAULT_WEIGHTS, percentile: DEFAULT_PERCENTILE, perSectionMin: DEFAULT_PER_SECTION_MIN, error: 'weights 须为 { title?, keyword?, body?, affiliation? } 正数' };
    for (const k of ['title', 'keyword', 'body', 'affiliation'] as const) {
      const v = (input.weights as Record<string, unknown>)[k];
      if (v === undefined) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { ok: false, sections: [], weights: DEFAULT_WEIGHTS, percentile: DEFAULT_PERCENTILE, perSectionMin: DEFAULT_PER_SECTION_MIN, error: `weights.${k} 须为非负实数：${String(v)}` };
      weights[k] = n;
    }
  }
  let percentile = DEFAULT_PERCENTILE;
  if (input.percentile !== undefined) {
    const n = Number(input.percentile);
    if (!Number.isFinite(n) || n <= 0 || n > 1) return { ok: false, sections: [], weights: DEFAULT_WEIGHTS, percentile: DEFAULT_PERCENTILE, perSectionMin: DEFAULT_PER_SECTION_MIN, error: `percentile 须为 (0,1] 相对分位（如 0.2=前 20%）：${String(input.percentile)}` };
    percentile = n;
  }
  let perSectionMin = DEFAULT_PER_SECTION_MIN;
  if (input.perSectionMin !== undefined) {
    const n = Number(input.perSectionMin);
    if (!Number.isInteger(n) || n < 0) return { ok: false, sections: [], weights: DEFAULT_WEIGHTS, percentile: DEFAULT_PERCENTILE, perSectionMin: DEFAULT_PER_SECTION_MIN, error: `perSectionMin 须为非负整数（每节至少入选条数）：${String(input.perSectionMin)}` };
    perSectionMin = n;
  }
  return { ok: true, sections, weights, percentile, perSectionMin };
}

/** 启发式词族：核心词=知识点标签本身（不硬编码任何学科词表）；扩展词留空交 LLM/用户补充；排除词=易混概念 */
export function deriveTermFamiliesHeuristic(sections: KnowledgeSection[]): TermFamily[] {
  return sections.map((s) => ({
    section: s.title,
    core: [...new Set(s.knowledgePoints.map((p) => p.trim()).filter(Boolean))],
    expansion: [],
    exclusion: [...new Set(s.confusables)],
  }));
}

/** 合并 LLM 派生词族：核心词始终含知识点标签（启发式兜底，防 LLM 漂移丢概念）；按节名对齐 */
export function mergeTermFamilies(base: TermFamily[], llm: unknown): { families: TermFamily[]; note: string } {
  if (!Array.isArray(llm)) return { families: base, note: 'LLM 词族不可用：只用核心词直取（可在 confusables/扩展输入补充）' };
  let merged = 0;
  const families = base.map((b) => {
    const hit = llm.find((x) => isObj(x) && x.section === b.section);
    if (!hit) return b;
    merged++;
    return {
      ...b,
      core: [...new Set([...b.core, ...strArr((hit as { core?: unknown }).core)])],
      expansion: [...new Set([...b.expansion, ...strArr((hit as { expansion?: unknown }).expansion)])],
      exclusion: [...new Set([...b.exclusion, ...strArr((hit as { exclusion?: unknown }).exclusion)])],
    };
  });
  return { families, note: merged > 0 ? `LLM 词族已并入 ${merged}/${base.length} 节` : 'LLM 词族与节名无一对应：只用核心词直取' };
}

export interface ScorableRecord {
  id: string;
  title: string;
  keywords: string[];
  body: string;
  affiliations: string[];
  session: string;
  defects: string[];
}

/** 归一化记录入口（接 parse_abstract_collection 输出，字段缺失给安全缺省） */
export function toScorable(raw: unknown[]): ScorableRecord[] {
  const out: ScorableRecord[] = [];
  for (const [i, r] of raw.entries()) {
    if (!isObj(r)) continue;
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : `R${i + 1}`,
      title: typeof r.title === 'string' ? r.title : '',
      keywords: strArr(r.keywords),
      body: typeof r.body === 'string' ? r.body : '',
      affiliations: strArr(r.affiliations),
      session: typeof r.session === 'string' ? r.session : '',
      defects: strArr(r.defects),
    });
  }
  return out;
}

function distinctHits(terms: string[], text: string): string[] {
  const t = text.toLowerCase();
  return terms.filter((term) => term && t.includes(term.toLowerCase()));
}

export interface CandidateScore {
  recordId: string;
  title: string;
  section: string;
  score: number;
  percentile: number;
  matchedCore: string[];
  matchedExpansion: string[];
  matchedExclusion: string[];
  /** 来源字段齐全（题名 + 作者或单位至少其一）——收敛条件 4 与复核判据 ④ */
  sourceComplete: boolean;
  defects: string[];
}

/** 评分：字段权重可配（一般题名>关键词>正文>单位/分会场，初值为建议）；排除词命中降权（×0.25） */
export function scoreRecords(records: ScorableRecord[], families: TermFamily[], weights: FieldWeights): CandidateScore[] {
  const out: CandidateScore[] = [];
  for (const fam of families) {
    for (const rec of records) {
      const inTitle = distinctHits(fam.core, rec.title);
      const inKw = distinctHits(fam.core, rec.keywords.join(' '));
      const inBody = distinctHits(fam.core, rec.body);
      const inAff = distinctHits(fam.core, `${rec.affiliations.join(' ')}\n${rec.session}`);
      const exHits = distinctHits(fam.exclusion, `${rec.title}\n${rec.keywords.join(' ')}\n${rec.body}`);
      const eTitle = distinctHits(fam.expansion, rec.title);
      const eKw = distinctHits(fam.expansion, rec.keywords.join(' '));
      const eBody = distinctHits(fam.expansion, rec.body);
      let score =
        weights.title * inTitle.length +
        weights.keyword * inKw.length +
        weights.body * Math.min(inBody.length, 5) +
        weights.affiliation * inAff.length +
        0.5 * (weights.title * eTitle.length + weights.keyword * eKw.length + weights.body * Math.min(eBody.length, 5));
      if (exHits.length > 0) score *= 0.25;
      // 零核心命中且无排除词命中才跳过；排除词命中保留候选（记录降权，落选理由留痕）
      if (score <= 0 && inTitle.length + inKw.length + inBody.length + inAff.length === 0 && exHits.length === 0) continue;
      out.push({
        recordId: rec.id,
        title: rec.title,
        section: fam.section,
        score: Math.round(score * 100) / 100,
        percentile: 0,
        matchedCore: [...new Set([...inTitle, ...inKw, ...inBody, ...inAff])],
        matchedExpansion: [...new Set([...eTitle, ...eKw, ...eBody])],
        matchedExclusion: exHits,
        sourceComplete: !!rec.title.trim() && (rec.keywords.length > 0 || !!rec.session.trim() || rec.affiliations.length > 0 || rec.body.trim().length > 0),
        defects: rec.defects,
      });
    }
  }
  return out;
}

/** 题名规范化去重：同记录跨节多候选按记录聚合；规范化后同串/互为子串的记录成簇，簇内保留最高分记录 */
export function dedupByTitle(candidates: CandidateScore[]): { kept: CandidateScore[]; duplicates: Map<string, string> } {
  const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const byRecord = new Map<string, CandidateScore[]>();
  for (const c of candidates) {
    const arr = byRecord.get(c.recordId) ?? [];
    arr.push(c);
    byRecord.set(c.recordId, arr);
  }
  const bestOf = (arr: CandidateScore[]) => arr.reduce((a, b) => (b.score > a.score ? b : a));
  const clusters: { keeper: string; norm: string }[] = [];
  const duplicates = new Map<string, string>();
  const keepIds = new Set<string>();
  for (const [recordId, arr] of byRecord) {
    const n = norm(arr[0].title);
    const cluster = clusters.find((c) => n && c.norm && (c.norm === n || (c.norm.length > 8 && n.length > 8 && (c.norm.includes(n) || n.includes(c.norm)))));
    if (cluster) {
      const keeperArr = byRecord.get(cluster.keeper)!;
      if (bestOf(arr).score > bestOf(keeperArr).score) {
        duplicates.set(cluster.keeper, recordId);
        keepIds.delete(cluster.keeper);
        cluster.keeper = recordId;
        keepIds.add(recordId);
      } else {
        duplicates.set(recordId, cluster.keeper);
      }
    } else {
      clusters.push({ keeper: recordId, norm: n });
      keepIds.add(recordId);
    }
  }
  return { kept: candidates.filter((c) => keepIds.has(c.recordId)), duplicates };
}

export interface SelectionResult {
  candidates: CandidateScore[];
  selected: (CandidateScore & { mustReview: boolean; rejectReason?: undefined })[];
  rejected: { recordId: string; title: string; section: string; reason: string }[];
  reviewQueue: { candidateId: string; score: number; percentile: number; section: string; decision: '预选' | '落选'; reason: string; sourceComplete: boolean }[];
  convergence: { met: boolean; conditions: { id: string; met: boolean; detail: string }[] };
  stats: { scored: number; selected: number; mustReview: number; perSection: Record<string, number> };
}

/**
 * 选文主流程：相对分位阈值 → 题名去重 → 覆盖面约束优先（每节至少 k 条，
 * 低于阈值补入者标 mustReview）→ 收敛四条件（3.7）。
 */
export function selectEvidence(input: {
  records?: unknown;
  sections?: unknown;
  families?: unknown;
  weights?: unknown;
  percentile?: unknown;
  perSectionMin?: unknown;
}): SelectionResult | { error: string } {
  const plan = planSelection(input);
  if (!plan.ok) return { error: plan.error ?? '输入校验失败' };
  if (!Array.isArray(input.records) || input.records.length === 0) {
    return { error: 'records 必填：非空数组（parse_abstract_collection 输出的 records）' };
  }
  const records = toScorable(input.records);
  const families: TermFamily[] = Array.isArray(input.families) && input.families.length > 0
    ? (input.families as TermFamily[]).map((f) => ({
        section: String(f.section ?? ''),
        core: strArr(f.core),
        expansion: strArr(f.expansion),
        exclusion: strArr(f.exclusion),
      }))
    : deriveTermFamiliesHeuristic(plan.sections);

  let candidates = scoreRecords(records, families, plan.weights);
  if (candidates.length === 0) {
    return {
      candidates: [],
      selected: [],
      rejected: [],
      reviewQueue: [],
      convergence: {
        met: false,
        conditions: [
          { id: 'keyPointCoverage', met: false, detail: '全部记录对所有词族零命中：回到词族扩展（3.2）或放宽阈值（3.5），不硬套' },
          { id: 'sectionPlacement', met: plan.sections.every((s) => s.declaredNoHit), detail: plan.sections.map((s) => s.title).join('、') },
          { id: 'noDuplicate', met: true, detail: '无入选即无重复' },
          { id: 'sourceComplete', met: true, detail: '无入选即无来源缺失' },
        ],
      },
      stats: { scored: 0, selected: 0, mustReview: 0, perSection: {} },
    };
  }

  // 相对分位阈值：排序后取前 percentile 比例处的分数线；零分永不入选
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  sorted.forEach((c, i) => {
    c.percentile = Math.round(((sorted.length - 1 - i) / Math.max(sorted.length - 1, 1)) * 100) / 100;
  });
  const cutIdx = Math.max(0, Math.ceil(plan.percentile * sorted.length) - 1);
  const cutScore = sorted[cutIdx].score;

  // 题名去重（同一记录跨节多候选时按记录去重，保留高分节归属）
  const { kept, duplicates } = dedupByTitle(sorted);
  const rejected: SelectionResult['rejected'] = [];
  for (const [dupId, keeperId] of duplicates) {
    const anyCand = sorted.find((c) => c.recordId === dupId);
    rejected.push({ recordId: dupId, title: anyCand?.title ?? records.find((r) => r.id === dupId)?.title ?? dupId, section: anyCand?.section ?? '', reason: `题名重复（保留 ${keeperId}）` });
  }

  const selected: SelectionResult['selected'] = [];
  const bySection = new Map<string, CandidateScore[]>();
  for (const fam of families) bySection.set(fam.section, []);
  for (const c of kept) {
    if (c.score < cutScore || c.score <= 0) continue;
    (bySection.get(c.section) ?? []).push(c);
  }
  // 覆盖面约束优先：某节候选不足时先放宽该节阈值补入（标必复核），而不是让热门主题挤满名单
  for (const fam of families) {
    const pool = kept.filter((c) => c.section === fam.section && c.score > 0).sort((a, b) => b.score - a.score);
    const chosen = bySection.get(fam.section) ?? [];
    for (const c of pool) {
      if (chosen.length >= plan.perSectionMin) break;
      if (!chosen.some((x) => x.recordId === c.recordId)) chosen.push(c);
    }
    bySection.set(fam.section, chosen);
  }
  for (const [, arr] of bySection) {
    for (const c of arr) {
      const mustReview = c.score < cutScore || c.defects.length > 0 || c.matchedExclusion.length > 0;
      selected.push({ ...c, mustReview });
    }
  }
  // 落选清单（供复核记录留痕：为什么选了这篇、没选那篇）
  const selectedIds = new Set(selected.map((s) => s.recordId));
  for (const c of sorted) {
    if (selectedIds.has(c.recordId)) continue;
    if (duplicates.has(c.recordId)) continue;
    rejected.push({
      recordId: c.recordId,
      title: c.title,
      section: c.section,
      reason: c.matchedExclusion.length > 0 ? `排除词命中（${c.matchedExclusion.join('、')}），降权后低于阈值` : `低于相对分位阈值（前 ${Math.round(plan.percentile * 100)}%）`,
    });
  }

  const perSection: Record<string, number> = {};
  for (const [s, arr] of bySection) perSection[s] = arr.length;

  // 收敛四条件（3.7）：数量由覆盖度决定，不设固定上限/凑数下限
  const cond1Detail: string[] = [];
  let cond1Met = true;
  for (const s of plan.sections) {
    const uncovered = s.keyPoints.filter((kp) => {
      const direct = selected.some((c) => c.section === s.title && (c.title.includes(kp) || c.matchedCore.includes(kp)));
      return !direct;
    });
    if (uncovered.length > 0) {
      cond1Met = false;
      cond1Detail.push(`${s.title}：${uncovered.join('、')} 无命中`);
    }
  }
  const cond2Fails = plan.sections.filter((s) => (bySection.get(s.title)?.length ?? 0) === 0 && !s.declaredNoHit);
  const cond4Bad = selected.filter((s) => !s.sourceComplete);
  const convergence: SelectionResult['convergence'] = {
    met: cond1Met && cond2Fails.length === 0 && cond4Bad.length === 0,
    conditions: [
      { id: 'keyPointCoverage', met: cond1Met, detail: cond1Met ? '每个重点知识点至少 1 条可对应证据' : cond1Detail.join('；') },
      { id: 'sectionPlacement', met: cond2Fails.length === 0, detail: cond2Fails.length === 0 ? '每一节都有落位（或无命中声明）' : `无落位且未声明无命中：${cond2Fails.map((s) => s.title).join('、')}` },
      { id: 'noDuplicate', met: true, detail: duplicates.size > 0 ? `题名去重已合并 ${duplicates.size} 条（保留高分者），无重复主题占位` : '无重复主题占位' },
      { id: 'sourceComplete', met: cond4Bad.length === 0, detail: cond4Bad.length === 0 ? '每篇来源字段齐全可核验' : `来源残缺：${cond4Bad.map((s) => s.recordId).join('、')}` },
    ],
  };

  const reviewQueue: SelectionResult['reviewQueue'] = [
    ...selected.map((s) => ({
      candidateId: s.recordId,
      score: s.score,
      percentile: s.percentile,
      section: s.section,
      decision: '预选' as const,
      reason: s.mustReview ? (s.score < cutScore ? '覆盖面补入，低于阈值' : s.matchedExclusion.length > 0 ? '排除词命中降权' : '抽取缺陷待核') : `过线（≥前 ${Math.round(plan.percentile * 100)}% 分数线 ${cutScore}）`,
      sourceComplete: s.sourceComplete,
    })),
    ...rejected.filter((r) => r.section !== '').map((r) => ({
      candidateId: r.recordId,
      score: sorted.find((c) => c.recordId === r.recordId && c.section === r.section)?.score ?? 0,
      percentile: sorted.find((c) => c.recordId === r.recordId && c.section === r.section)?.percentile ?? 0,
      section: r.section,
      decision: '落选' as const,
      reason: r.reason,
      sourceComplete: sorted.find((c) => c.recordId === r.recordId && c.section === r.section)?.sourceComplete ?? false,
    })),
  ].sort((a, b) => b.score - a.score);

  return {
    candidates: sorted,
    selected,
    rejected: rejected.filter((r) => r.section !== '' || r.reason.startsWith('题名重复')),
    reviewQueue,
    convergence,
    stats: { scored: sorted.length, selected: selected.length, mustReview: selected.filter((s) => s.mustReview).length, perSection },
  };
}
