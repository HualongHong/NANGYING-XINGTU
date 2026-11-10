/**
 * 跨材料一致性核查（audit_consistency，技能 #23，R4-4）。
 *
 * 背景（反馈 a 4.2-N1）：项目侧人工修了 9 处跨材料逻辑冲突（大纲/日历/进度表/
 * 考核方案互相矛盾）。本技能对多份课程资产做启发式交叉比对：
 *   1) 日期冲突：同一事项关键词（考试/截止/交付/上课…）在不同材料中日期不一致；
 *   2) 学时口径：各材料声称的学时/课时总数不一致；
 *   3) 数值口径：同一指标名（如 总学分/实验次数）取值不一致；
 *   4) 覆盖矛盾：某材料声称"覆盖/包含"的术语在其他材料中完全缺失（低置信提示）。
 * 每项冲突带涉及资产与修改建议。LLM 注入时兜底复核（启发式未发现时补充语义级
 * 冲突，如前后矛盾表述）；LLM 失败不影响启发式结果。纯 TS、零 Node API、确定性。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';

export const AUDIT_CONSISTENCY_ID = 'audit_consistency';

export interface AuditAsset {
  id: string;
  title?: string;
  /** 材料纯文本（适配层负责 path → text 的读取） */
  text: string;
}

export type ConflictType = 'date' | 'hours' | 'number' | 'coverage';
export type ConflictSeverity = 'high' | 'medium' | 'low';

export interface ConflictItem {
  type: ConflictType;
  severity: ConflictSeverity;
  /** 涉及资产 id */
  assets: string[];
  /** 冲突描述（中文，含具体取值） */
  description: string;
  /** 修改建议 */
  suggestion: string;
}

export interface AuditConsistencyInput {
  assets: AuditAsset[];
}

export interface AuditReport {
  conflicts: ConflictItem[];
  checkedAssets: number;
  stats: { byType: Record<string, number> };
}

// ---------- 启发式抽取 ----------

const DATE_RE = /(\d{4})[年\/-](\d{1,2})[月\/-](\d{1,2})/g;
const DATE_KEYWORDS = ['考试', '考查', '截止', '提交', '交付', '上课', '开课', '答辩', '测验', '截止日'];
const HOURS_RE = /(?:总)?(?:学时|课时)[^\d]{0,6}(\d+)/g;
const LABEL_NUMBER_RE = /([一-龥]{2,8})\s*[:：]\s*(\d+)/g;
const CLAIM_RE = /(?:覆盖|包含|涵盖)([^。；，]{2,24})/g;

interface DateHit { date: string; context: string; assetId: string; }

/** 日期归一化：2026-10-1 / 2026年10月1日 → 2026-10-01 */
function normDate(y: string, m: string, d: string): string {
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** 启发式冲突检测（确定性） */
export function heuristicConflicts(assets: AuditAsset[]): ConflictItem[] {
  const conflicts: ConflictItem[] = [];

  // 1) 日期冲突：同一事项关键词在不同材料中日期不同
  const byContext = new Map<string, DateHit[]>();
  for (const asset of assets) {
    for (const kw of DATE_KEYWORDS) {
      let idx = 0;
      while ((idx = asset.text.indexOf(kw, idx)) !== -1) {
        const window = asset.text.slice(Math.max(0, idx - 24), idx + kw.length + 24);
        for (const m of window.matchAll(DATE_RE)) {
          const hit: DateHit = {
            date: normDate(m[1], m[2], m[3]),
            context: kw,
            assetId: asset.id,
          };
          byContext.set(kw, [...(byContext.get(kw) ?? []), hit]);
        }
        idx += kw.length;
      }
    }
  }
  for (const [kw, hits] of byContext) {
    const distinct = [...new Set(hits.map((h) => h.date))];
    const involved = [...new Set(hits.map((h) => h.assetId))];
    if (distinct.length > 1 && involved.length > 1) {
      conflicts.push({
        type: 'date',
        severity: 'high',
        assets: involved,
        description: `「${kw}」日期不一致：${hits.map((h) => `${h.assetId}=${h.date}`).join('，')}`,
        suggestion: `统一「${kw}」日期（以教务口径为准），并同步修改其余 ${involved.length - 1} 份材料`,
      });
    }
  }

  // 2) 学时口径：各材料总学时不同
  const hours = assets.map((a) => {
    const m = HOURS_RE.exec(a.text);
    HOURS_RE.lastIndex = 0;
    return m ? { id: a.id, hours: Number(m[1]) } : null;
  }).filter((x): x is { id: string; hours: number } => x !== null);
  const hourValues = [...new Set(hours.map((h) => h.hours))];
  if (hourValues.length > 1) {
    conflicts.push({
      type: 'hours',
      severity: 'high',
      assets: hours.map((h) => h.id),
      description: `总学时口径不一致：${hours.map((h) => `${h.id}=${h.hours}学时`).join('，')}`,
      suggestion: '以教学大纲为准统一总学时，并核对各材料的分项分配是否随之调整',
    });
  }

  // 3) 数值口径：同一指标名取值不同
  const byLabel = new Map<string, Map<string, string>>();
  for (const asset of assets) {
    for (const m of asset.text.matchAll(LABEL_NUMBER_RE)) {
      const label = m[1];
      if (/^(图|表|第|共|如)$/.test(label)) continue;
      if (/学时|课时$/.test(label)) continue; // 学时口径由 hours 规则专属，避免双重报告
      const perAsset = byLabel.get(label) ?? new Map<string, string>();
      perAsset.set(asset.id, m[2]);
      byLabel.set(label, perAsset);
    }
  }
  for (const [label, perAsset] of byLabel) {
    const values = [...new Set(perAsset.values())];
    if (values.length > 1 && perAsset.size > 1) {
      const assetsInvolved = [...perAsset.keys()];
      conflicts.push({
        type: 'number',
        severity: 'medium',
        assets: assetsInvolved,
        description: `「${label}」取值不一致：${assetsInvolved.map((id) => `${id}=${perAsset.get(id)}`).join('，')}`,
        suggestion: `统一「${label}」取值，并检查是笔误还是版本漂移`,
      });
    }
  }

  // 4) 覆盖矛盾：A 声称覆盖的术语在其他材料中完全缺失（低置信提示）
  const termFreq = new Map<string, Map<string, number>>();
  const countTerm = (assetId: string, term: string) => {
    const per = termFreq.get(term) ?? new Map<string, number>();
    per.set(assetId, (per.get(assetId) ?? 0) + 1);
    termFreq.set(term, per);
  };
  for (const asset of assets) {
    for (const m of asset.text.matchAll(CLAIM_RE)) {
      for (const term of m[1].split(/[、，,与和及]/).map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 20)) {
        countTerm(asset.id, term);
      }
    }
  }
  for (const [term, per] of termFreq) {
    const holders = [...per.keys()];
    const missing = assets.filter((a) => !a.text.includes(term)).map((a) => a.id);
    if (holders.length > 0 && missing.length > 0 && missing.length < assets.length) {
      conflicts.push({
        type: 'coverage',
        severity: 'low',
        assets: [...holders, ...missing],
        description: `「${holders.join('、')}」声称覆盖「${term}」，但 ${missing.join('、')} 中未出现该术语`,
        suggestion: `确认「${term}」是否应纳入缺失材料；若已移出教学范围，请修订声称覆盖的表述`,
      });
    }
  }

  return conflicts;
}

// ---------- 主入口 ----------

export async function auditConsistency(
  input: AuditConsistencyInput,
  ctx: SkillContext = {},
): Promise<SkillResult<AuditReport>> {
  const assets = Array.isArray(input?.assets) ? input.assets : [];
  if (assets.length < 2 || !assets.every((a) => a && typeof a.id === 'string' && typeof a.text === 'string')) {
    return {
      skillId: AUDIT_CONSISTENCY_ID,
      level: 'unavailable',
      degradationNote: '输入校验失败：assets 须为 ≥2 项数组，每项 { id, title?, text }（text 为材料纯文本；文件路径由适配层读取后传入）',
      errorCode: 'INVALID_INPUT',
      example: '{ "assets": [{ "id": "大纲", "title": "教学大纲", "text": "总学时：96……" }, { "id": "日历", "title": "教学日历", "text": "总学时：64……" }] }',
    };
  }

  const conflicts = heuristicConflicts(assets);
  let note = '';

  // LLM 兜底复核：补充语义级冲突（启发式不替 LLM 结论背书，去重后合并）
  if (ctx.llm) {
    const prompt = [
      '你是课程材料一致性审核助手。以下是多份课程材料的摘录（JSON）：',
      JSON.stringify(assets.map((a) => ({ id: a.id, title: a.title ?? '', text: a.text.slice(0, 1500) }))),
      '请找出跨材料的逻辑冲突（日期/学时/数值口径不一致、前后矛盾、覆盖范围矛盾）。',
      '严格以 JSON 数组返回：[{"type":"date|hours|number|coverage","assetIds":["id1","id2"],"description":"…","suggestion":"…"}]；无冲突返回 []，只输出 JSON 数组本身。',
    ].join('\n');
    try {
      const raw = (await ctx.llm.complete(prompt, { temperature: 0.2 })).trim();
      const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
      const parsed: unknown = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
      const ids = new Set(assets.map((a) => a.id));
      const seen = new Set(conflicts.map((c) => `${c.type}:${[...c.assets].sort().join('|')}:${c.description.slice(0, 12)}`));
      for (const p of parsed.slice(0, 20)) {
        const o = p as Record<string, unknown>;
        const item: ConflictItem = {
          type: ['date', 'hours', 'number', 'coverage'].includes(String(o.type)) ? (o.type as ConflictType) : 'number',
          severity: 'medium',
          assets: Array.isArray(o.assetIds) ? o.assetIds.filter((x): x is string => typeof x === 'string' && ids.has(x)) : [],
          description: typeof o.description === 'string' ? o.description : '',
          suggestion: typeof o.suggestion === 'string' ? o.suggestion : '',
        };
        if (item.assets.length === 0 || !item.description) continue;
        const key = `${item.type}:${[...item.assets].sort().join('|')}:${item.description.slice(0, 12)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push(item);
      }
    } catch {
      note = 'LLM 语义复核失败，已保留启发式核查结果';
    }
  }

  const byType: Record<string, number> = {};
  for (const c of conflicts) byType[c.type] = (byType[c.type] ?? 0) + 1;

  return {
    skillId: AUDIT_CONSISTENCY_ID,
    level: note ? 'degraded' : 'full',
    data: { conflicts, checkedAssets: assets.length, stats: { byType } },
    degradationNote: note,
  };
}
