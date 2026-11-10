/**
 * 候选标签语义聚类（LLM 宿主注入）——候选池质量增强。
 *
 * 确定性规则（归一化相等/子串/投票）合并不了的同义近义标签
 * （如"比色皿/比色杯/比色池"），由宿主 LLM 聚成规范概念簇：
 * 输入标签多于一批（默认 ≤100）时自动分批，分批结果按 canonical
 * 归一化相等并簇。LLM 返回非法 JSON → 该批降级跳过（整体标 degraded），
 * 绝不抛异常中断主流程；未注入 llm → 空聚类 + degraded 说明。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';
import { normalizeLabel } from '../graph/diffKnowledgeGraphs.js';

export interface ClusterItem {
  term: string;
  /** 词频（用于 totalFreq 汇总与 canonical 取舍参考） */
  freq: number;
}

export interface SemanticCluster {
  canonical: string;
  members: string[];
  totalFreq: number;
}

export interface SemanticClusterOutput {
  clusters: SemanticCluster[];
}

export interface SemanticClusterOptions {
  batchSize?: number;
}

export const SEMANTIC_CLUSTER_ID = 'semantic_cluster_labels';

function parseClusters(raw: string): SemanticCluster[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('LLM 返回不是数组');
  const out: SemanticCluster[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as { canonical?: unknown; members?: unknown };
    if (typeof c.canonical !== 'string' || c.canonical.trim() === '') continue;
    const members = Array.isArray(c.members)
      ? c.members.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      : [];
    out.push({ canonical: c.canonical.trim(), members: [...new Set(members)], totalFreq: 0 });
  }
  return out;
}

/** 语义聚类候选标签（core 纯 TS；LLM 经 ctx 宿主注入） */
export async function semanticClusterLabels(
  items: ClusterItem[],
  ctx: SkillContext = {},
  opts: SemanticClusterOptions = {},
): Promise<SkillResult<SemanticClusterOutput>> {
  if (!ctx.llm) {
    return {
      skillId: SEMANTIC_CLUSTER_ID,
      level: 'degraded',
      data: { clusters: [] },
      degradationNote: '未注入 LLM，语义聚类不可用',
    };
  }
  if (items.length === 0) {
    return { skillId: SEMANTIC_CLUSTER_ID, level: 'full', data: { clusters: [] }, degradationNote: '' };
  }

  const batchSize = Math.max(1, opts.batchSize ?? 100);
  const batches: ClusterItem[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  const freqOf = new Map(items.map((x) => [x.term, x.freq]));
  const merged = new Map<string, SemanticCluster>(); // 归一化 canonical -> 簇
  const notes: string[] = [];
  let level: 'full' | 'degraded' = 'full';

  for (const [batchIdx, batch] of batches.entries()) {
    const prompt = [
      '你是课程术语聚类助手。请把以下术语按语义聚成规范概念簇（同义/近义/同一事物的不同措辞归一簇），JSON 数组返回：',
      '[{"canonical":"规范概念名","members":["成员术语",…]},…]。',
      'canonical 取最通用简短的写法；无近义的术语单独成簇（members 可为空数组）。只输出 JSON。',
      JSON.stringify(batch.map((x) => x.term)),
    ].join('\n');
    try {
      const raw = await ctx.llm.complete(prompt, { temperature: 0.2 });
      const clusters = parseClusters(raw);
      for (const c of clusters) {
        const key = normalizeLabel(c.canonical);
        const prev = merged.get(key);
        if (prev) {
          prev.members = [...new Set([...prev.members, ...c.members, c.canonical])].filter(
            (m) => m !== prev.canonical,
          );
        } else {
          merged.set(key, { canonical: c.canonical, members: c.members, totalFreq: 0 });
        }
      }
    } catch {
      level = 'degraded';
      notes.push(`第 ${batchIdx + 1} 批聚类失败（非法返回），已跳过`);
    }
  }

  // 汇总词频：canonical 取成员中词频最高者的频次之和（成员含 canonical 自身）
  const clusters = [...merged.values()].map((c) => {
    const all = [c.canonical, ...c.members];
    const totalFreq = all.reduce((n, m) => n + (freqOf.get(m) ?? 0), 0);
    return { ...c, totalFreq };
  });
  clusters.sort((a, b) => b.totalFreq - a.totalFreq || a.canonical.localeCompare(b.canonical, 'zh'));

  return {
    skillId: SEMANTIC_CLUSTER_ID,
    level,
    data: { clusters },
    degradationNote: notes.join('；'),
  };
}

/** 聚类结果 → 成员术语到 canonical 的映射（含 canonical 自身映射） */
export function clusterMapping(clusters: SemanticCluster[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of clusters) {
    map.set(c.canonical, c.canonical);
    for (const m of c.members) map.set(m, c.canonical);
  }
  return map;
}
