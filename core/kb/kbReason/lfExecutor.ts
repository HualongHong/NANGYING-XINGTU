/**
 * LF 确定性执行器（SPEC §4.6）：同一逻辑式 + 同一 KB → 同一结果（纯函数零 LLM）。
 * 输出答案 + 执行轨迹（每步算子、输入/输出规模、样例 id，可审计）；步数硬上限防失控。
 */
import { KB_LIMITS } from '../kbSchema.js';
import { neighborsOf } from '../kbIndex.js';
import type { TeachingKnowledgeBase } from '../kbTypes.js';
import { isLfNode, type LfNode } from './lfGrammar.js';

/** 算子间流动的值：实体集（带类型）或数值 */
export type LfValue =
  | { type: 'concepts'; ids: string[] }
  | { type: 'evidence'; ids: string[] }
  | { type: 'number'; value: number }
  | { type: 'comparison'; a: number; b: number; diff: number; greater: 'a' | 'b' | 'equal' };

export interface LfTraceStep {
  step: number;
  op: string;
  inputSize: number;
  outputType: LfValue['type'];
  outputSize: number;
  /** 样例 id（前 3 个，审计用） */
  sample: string[];
}

export interface LfExecutionResult {
  value: LfValue;
  trace: LfTraceStep[];
}

function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

export function executeLogicalForm(kb: TeachingKnowledgeBase, plan: LfNode): LfExecutionResult {
  const trace: LfTraceStep[] = [];
  let steps = 0;
  const conceptById = new Map(kb.concepts.map((c) => [c.id, c]));
  const evidenceById = new Map(kb.evidence.map((e) => [e.id, e]));

  const resolveSet = (v: unknown, expect: 'concepts' | 'evidence'): string[] => {
    if (isLfNode(v)) {
      const r = run(v);
      if (r.type === 'concepts' || r.type === 'evidence') return r.ids;
      throw new Error(`嵌套 LF 产出 ${r.type}，此处须为实体集`);
    }
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
    throw new Error(`须为嵌套 LF 或 id 数组（期望 ${expect}）`);
  };

  const run = (node: LfNode): LfValue => {
    steps += 1;
    if (steps > KB_LIMITS.maxExecutorSteps) {
      throw new Error(`执行步数超硬上限 ${KB_LIMITS.maxExecutorSteps}`);
    }
    const a = node.args;
    let value: LfValue;
    let inputSize = 0;
    switch (node.op) {
      case 'FIND': {
        if (a.entity === 'concept') {
          const where = (a.where ?? {}) as { labelContains?: string; origin?: string };
          const ids = kb.concepts
            .filter((c) => (where.labelContains ? c.label.includes(where.labelContains) || c.aliases.some((x) => x.includes(where.labelContains!)) : true))
            .filter((c) => (where.origin ? c.origin === where.origin : true))
            .map((c) => c.id);
          value = { type: 'concepts', ids: sortedUnique(ids) };
        } else {
          const where = (a.where ?? {}) as { labelContains?: string; origin?: string };
          const ids = kb.evidence
            .filter((e) => (where.labelContains ? e.text.includes(where.labelContains!) : true))
            .filter((e) => (where.origin ? e.origin === where.origin : true))
            .map((e) => e.id);
          value = { type: 'evidence', ids: sortedUnique(ids) };
        }
        inputSize = a.entity === 'concept' ? kb.concepts.length : kb.evidence.length;
        break;
      }
      case 'FILTER': {
        const set = run(a.of as LfNode);
        inputSize = set.type === 'concepts' || set.type === 'evidence' ? set.ids.length : 0;
        if (set.type === 'concepts') {
          value = {
            type: 'concepts',
            ids: set.ids.filter((id) => String(conceptById.get(id)?.[a.field as string as 'label'] ?? '') === String(a.equals)),
          };
        } else if (set.type === 'evidence') {
          value = {
            type: 'evidence',
            ids: set.ids.filter((id) => String(evidenceById.get(id)?.[a.field as string as 'origin'] ?? '') === String(a.equals)),
          };
        } else {
          throw new Error('FILTER 的 of 须为实体集');
        }
        break;
      }
      case 'TRAVERSE': {
        const from = resolveSet(a.from, 'concepts');
        inputSize = from.length;
        const edge = a.edge as string;
        const direction = (a.direction as string | undefined) ?? 'both';
        const depth = (a.depth as number | undefined) ?? 1;
        let frontier = new Set(from);
        const visited = new Set(from);
        for (let d = 0; d < depth; d++) {
          const next = new Set<string>();
          for (const id of frontier) {
            for (const nb of neighborsOf(kb.indexes.adjacency, id)) {
              if (nb.type !== edge) continue;
              if (direction !== 'both' && nb.direction !== direction) continue;
              if (!visited.has(nb.to)) {
                visited.add(nb.to);
                next.add(nb.to);
              }
            }
          }
          frontier = next;
        }
        value = { type: 'concepts', ids: sortedUnique(visited) };
        break;
      }
      case 'RETRIEVE': {
        const conceptIds = resolveSet(a.conceptIds, 'concepts');
        inputSize = conceptIds.length;
        const evIds: string[] = [];
        for (const cId of conceptIds) {
          evIds.push(...(kb.links.conceptToEvidence[cId] ?? []));
        }
        value = { type: 'evidence', ids: sortedUnique(evIds) };
        break;
      }
      case 'COUNT': {
        const set = run(a.of as LfNode);
        if (set.type === 'comparison') throw new Error('COUNT 的 of 须为实体集或数值');
        inputSize = set.type === 'number' ? 1 : set.ids.length;
        value = { type: 'number', value: set.type === 'number' ? set.value : set.ids.length };
        break;
      }
      case 'COMPARE': {
        const num = (v: unknown): number => {
          if (typeof v === 'number') return v;
          if (isLfNode(v)) {
            const r = run(v);
            if (r.type === 'number') return r.value;
            if (r.type === 'concepts' || r.type === 'evidence') return r.ids.length;
            throw new Error('COMPARE 子式须产出数值或实体集');
          }
          throw new Error('COMPARE 参数须为嵌套 LF 或数值');
        };
        const av = num(a.a);
        const bv = num(a.b);
        inputSize = 2;
        value = { type: 'comparison', a: av, b: bv, diff: av - bv, greater: av > bv ? 'a' : av < bv ? 'b' : 'equal' };
        break;
      }
      case 'SORT': {
        const set = run(a.of as LfNode);
        inputSize = set.type === 'concepts' || set.type === 'evidence' ? set.ids.length : 0;
        const order = (a.order as string | undefined) ?? 'desc';
        const field = a.field as string;
        const numOf = (id: string): number => {
          const rec = (set.type === 'concepts' ? conceptById.get(id) : evidenceById.get(id)) as Record<string, unknown> | undefined;
          const v = rec?.[field];
          return typeof v === 'number' ? v : 0;
        };
        if (set.type !== 'concepts' && set.type !== 'evidence') throw new Error('SORT 的 of 须为实体集');
        const ids = [...set.ids].sort((x, y) => (order === 'desc' ? numOf(y) - numOf(x) : numOf(x) - numOf(y)) || x.localeCompare(y));
        value = { type: set.type, ids };
        break;
      }
      case 'GAP': {
        const scope = a.conceptIds !== undefined ? resolveSet(a.conceptIds, 'concepts') : kb.concepts.map((c) => c.id);
        inputSize = scope.length;
        const ids = scope.filter((id) => (kb.links.conceptToEvidence[id] ?? []).length === 0);
        value = { type: 'concepts', ids: sortedUnique(ids) };
        break;
      }
      default:
        throw new Error(`未知算子 ${node.op}（执行器白名单外——应先经 lfValidator 拦截）`);
    }
    trace.push({
      step: steps,
      op: node.op,
      inputSize,
      outputType: value.type,
      outputSize: value.type === 'number' ? 1 : value.type === 'comparison' ? 2 : value.ids.length,
      sample: value.type === 'concepts' || value.type === 'evidence' ? value.ids.slice(0, 3) : [],
    });
    return value;
  };

  const value = run(plan);
  return { value, trace };
}
