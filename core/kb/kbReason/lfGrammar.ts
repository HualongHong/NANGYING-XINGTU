/**
 * KAG-lite 逻辑式语法（SPEC §4.6）：算子注册表（operator registry）——
 * 白名单起步 8 算子，扩容=加注册项不重写（§4.7 演进通道）。
 * LF 为嵌套 JSON：{ op, args }；实体集在算子间流动（concept/evidence id 集、数值、行集）。
 * 字段白名单来自 KB_ENTITY_FIELDS（schema-first：kbSchema 数据驱动）。
 */
import { KB_ENTITY_FIELDS, KB_LIMITS } from '../kbSchema.js';

/** LF 节点（嵌套逻辑式） */
export interface LfNode {
  op: string;
  args: Record<string, unknown>;
}

/** 算子声明：args 校验（返回错误消息或 null） */
export interface LfOperatorDecl {
  name: string;
  /** 参数校验（结构级；引用完整性归 validator/executor） */
  checkArgs(args: Record<string, unknown>): string | null;
  /** 手册行（planner few-shot 提示用） */
  manual: string;
}

function isLf(v: unknown): v is LfNode {
  return typeof v === 'object' && v !== null && typeof (v as LfNode).op === 'string';
}

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

const conceptFields = new Set<string>(KB_ENTITY_FIELDS.concept);
const evidenceFields = new Set<string>(KB_ENTITY_FIELDS.evidence);

/** 算子注册表（演进=加条目；validator/planner 手册自动跟随） */
const OPERATOR_LIST: LfOperatorDecl[] = [
    {
      name: 'FIND',
      manual: 'FIND { entity: "concept"|"evidence", where: { labelContains?: string, origin?: string } } → 实体集。按标签包含/来源找概念或证据。',
      checkArgs(a) {
        if (a.entity !== 'concept' && a.entity !== 'evidence') return 'entity 须为 concept|evidence';
        if (a.where !== undefined && (typeof a.where !== 'object' || a.where === null)) return 'where 须为对象';
        return null;
      },
    },
    {
      name: 'FILTER',
      manual: 'FILTER { of: <LF>, field: string, equals: string|number } → 实体集。按字段等值过滤（字段须在 schema 白名单）。',
      checkArgs(a) {
        if (!isLf(a.of)) return 'of 须为嵌套 LF';
        if (typeof a.field !== 'string' || (!conceptFields.has(a.field) && !evidenceFields.has(a.field))) {
          return `field 须在白名单：concept(${[...conceptFields].join('/')}) evidence(${[...evidenceFields].join('/')})`;
        }
        if (typeof a.equals !== 'string' && typeof a.equals !== 'number') return 'equals 须为 string|number';
        return null;
      },
    },
    {
      name: 'TRAVERSE',
      manual: 'TRAVERSE { from: <LF>|string[], edge: "prerequisite"|"related", direction: "out"|"in"|"both", depth: 1..3 } → 概念集。沿图谱边扩展（多跳推理核心）。',
      checkArgs(a) {
        if (!isLf(a.from) && !isStrArray(a.from)) return 'from 须为嵌套 LF 或概念 id 数组';
        if (a.edge !== 'prerequisite' && a.edge !== 'related') return 'edge 须为 prerequisite|related';
        if (a.direction !== undefined && !['out', 'in', 'both'].includes(a.direction as string)) return 'direction 须为 out|in|both';
        const d = a.depth ?? 1;
        if (typeof d !== 'number' || d < 1 || d > KB_LIMITS.maxTraverseDepth) return `depth 须为 1..${KB_LIMITS.maxTraverseDepth}`;
        return null;
      },
    },
    {
      name: 'RETRIEVE',
      manual: 'RETRIEVE { conceptIds: <LF>|string[] } → 证据集。取概念挂接的证据（概念→证据桥）。',
      checkArgs(a) {
        if (!isLf(a.conceptIds) && !isStrArray(a.conceptIds)) return 'conceptIds 须为嵌套 LF 或概念 id 数组';
        return null;
      },
    },
    {
      name: 'COUNT',
      manual: 'COUNT { of: <LF> } → 数值。实体集计数（聚合类问题）。',
      checkArgs(a) {
        if (!isLf(a.of)) return 'of 须为嵌套 LF';
        return null;
      },
    },
    {
      name: 'COMPARE',
      manual: 'COMPARE { a: <LF>|number, b: <LF>|number } → { a, b, diff, greater }。数值比较（两边为 LF 时取其计数）。',
      checkArgs(a) {
        const ok = (v: unknown) => isLf(v) || typeof v === 'number';
        if (!ok(a.a) || !ok(a.b)) return 'a/b 须为嵌套 LF 或数值';
        return null;
      },
    },
    {
      name: 'SORT',
      manual: 'SORT { of: <LF>, field: string, order?: "asc"|"desc" } → 实体集（排序后）。字段须在 schema 白名单且为数值字段。',
      checkArgs(a) {
        if (!isLf(a.of)) return 'of 须为嵌套 LF';
        if (typeof a.field !== 'string' || (!conceptFields.has(a.field) && !evidenceFields.has(a.field))) return 'field 须在白名单';
        if (a.order !== undefined && !['asc', 'desc'].includes(a.order as string)) return 'order 须为 asc|desc';
        return null;
      },
    },
    {
      name: 'GAP',
      manual: 'GAP { conceptIds?: <LF>|string[] } → 概念集。缺口检测：无证据（或指定集合中无证据）的概念（采集规划入口）。',
      checkArgs(a) {
        if (a.conceptIds !== undefined && !isLf(a.conceptIds) && !isStrArray(a.conceptIds)) return 'conceptIds 须为嵌套 LF 或概念 id 数组';
        return null;
      },
    },
];

export const LF_OPERATORS: ReadonlyMap<string, LfOperatorDecl> = new Map(
  OPERATOR_LIST.map((d) => [d.name, d] as [string, LfOperatorDecl]),
);

/** 展开 LF：节点数与最大嵌套深度（校验护栏用） */
export function measureLf(node: unknown): { ops: number; depth: number } {
  if (!isLf(node)) return { ops: 0, depth: 0 };
  let ops = 1;
  let depth = 1;
  for (const v of Object.values(node.args ?? {})) {
    const children: unknown[] = Array.isArray(v) ? v : [v];
    for (const c of children) {
      const m = measureLf(c);
      ops += m.ops;
      depth = Math.max(depth, 1 + m.depth);
    }
  }
  return { ops, depth };
}

export function isLfNode(v: unknown): v is LfNode {
  return isLf(v);
}
