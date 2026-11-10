/**
 * 实验型知识图谱（extract_knowledge_graph 的 graphType=experimental 模式，R4-1）。
 *
 * 背景（反馈 b P0-4）：概念层图谱只到"章节—概念"，实体是字段名而非实验要素，
 * 实验课程需要按"键:值"字段解析的实验型图谱。
 *
 * 输入："章节 + 字段"形态——sections[].fields 的键映射到八类实验要素：
 *   标准/样品/指标/仪器/操作链/质控/产出/难点（键名可经 fieldMap 配置映射）。
 * 实体类型：experiment/standard/sample/indicator/instrument/step/qc/output/difficulty；
 * 关系：based_on（实验依据标准）、measures（测定指标）、uses（使用仪器）、
 *   step_order（操作链保序）、produces（产出数据）、has_qc（质控）、difficulty_of（难点）。
 * 输出信封与星图中枢对齐（schemaVersion/graphType/nodes/edges/stats），
 * hierarchy 与 prerequisiteGraph 为空（实验结构不靠先修链）。
 *
 * 纯 TS、零 Node API、确定性 ID（djb2，与概念图谱同哈希族）。
 */
import type { SkillContext } from '../llm.js';
import type { SkillResult } from '../types.js';

export const EXPERIMENTAL_GRAPH_SCHEMA_VERSION = '1.2';

export type ExperimentalEntityType =
  | 'experiment' | 'standard' | 'sample' | 'indicator'
  | 'instrument' | 'step' | 'qc' | 'output' | 'difficulty';

export type ExperimentalEdgeType =
  | 'based_on' | 'measures' | 'uses' | 'step_order'
  | 'produces' | 'has_qc' | 'difficulty_of';

export interface ExperimentalNode {
  id: string;
  type: ExperimentalEntityType;
  label: string;
  /** 所属实验章节标识（如 W02） */
  week?: string;
  /** step 的操作序（1 起） */
  order?: number;
}

export interface ExperimentalEdge {
  from: string;
  to: string;
  type: ExperimentalEdgeType;
  /** step_order 边的操作序 */
  order?: number;
}

export interface ExperimentalGraph {
  schemaVersion: string;
  graphType: 'experimental';
  nodes: ExperimentalNode[];
  edges: ExperimentalEdge[];
  /** 信封对齐：实验结构不靠章节树与先修链 */
  hierarchy: [];
  prerequisiteGraph: { nodes: string[]; edges: [] };
  stats: {
    nodes: number;
    edges: number;
    byType: Record<string, number>;
  };
}

/** 一节实验课：标题 + 字段表（值可为数组或分隔字符串） */
export interface ExperimentalSection {
  id?: string;
  title: string;
  fields: Record<string, unknown>;
}

export interface ExtractExperimentalGraphInput {
  sections: ExperimentalSection[];
  /** 键名映射：用户字段名 → 八类标准键（standard/sample/indicator/instrument/step/qc/output/difficulty） */
  fieldMap?: Record<string, string>;
}

// ---------- 确定性 ID（与概念图谱同 djb2 哈希族） ----------

function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** 字段键别名 → 标准键（大小写/常见别名归一；fieldMap 优先） */
const FIELD_KEY_ALIASES: Record<string, string> = {
  标准: 'standard', 依据: 'standard', 依据标准: 'standard', 国标: 'standard',
  样品: 'sample', 样本: 'sample', 材料: 'sample',
  指标: 'indicator', 测定指标: 'indicator', 参数: 'indicator',
  仪器: 'instrument', 设备: 'instrument', 器材: 'instrument',
  操作链: 'step', 步骤: 'step', 流程: 'step', 操作步骤: 'step',
  质控: 'qc', 质量控制: 'qc', 质控措施: 'qc',
  产出: 'output', 数据产出: 'output', 产出物: 'output', 数据: 'output',
  难点: 'difficulty', 困难: 'difficulty', 难点分析: 'difficulty',
};

const STANDARD_KEYS = new Set([
  'standard', 'sample', 'indicator', 'instrument', 'step', 'qc', 'output', 'difficulty',
]);

function canonicalFieldKey(rawKey: string, fieldMap?: Record<string, string>): string | null {
  const key = rawKey.trim();
  if (!key) return null;
  if (fieldMap) {
    const mapped = fieldMap[key] ?? fieldMap[key.toLowerCase()];
    if (mapped && STANDARD_KEYS.has(mapped)) return mapped;
  }
  const direct = FIELD_KEY_ALIASES[key];
  if (direct) return direct;
  const lowered = key.toLowerCase();
  if (STANDARD_KEYS.has(lowered)) return lowered;
  return null;
}

/** 字段值归一为条目列表（数组原样；字符串按 、，,；; 切分） */
export function fieldValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[、，,；;]/).map((v) => v.trim()).filter(Boolean);
  }
  if (value === undefined || value === null) return [];
  return [String(value).trim()].filter(Boolean);
}

/** 主入口：构建实验型知识图谱 */
export function extractExperimentalGraph(
  input: ExtractExperimentalGraphInput,
  _ctx: SkillContext = {},
): SkillResult<ExperimentalGraph> {
  const sections = Array.isArray(input?.sections) ? input.sections : [];
  if (sections.length === 0 || !sections.every((s) => s && typeof s.title === 'string' && s.fields && typeof s.fields === 'object')) {
    return {
      skillId: 'extract_knowledge_graph',
      level: 'unavailable',
      degradationNote: '输入校验失败：experimental 模式需要 sections 数组（每项 { id?, title, fields: { 字段键: 值 } }）；键名可为 标准/样品/指标/仪器/操作链/质控/产出/难点 或经 fieldMap 映射',
      errorCode: 'INVALID_INPUT',
      example: '{ "graphType": "experimental", "sections": [{ "id": "W02", "title": "水质多参数分析", "fields": { "标准": ["HJ 1147-2020"], "指标": ["pH", "溶解氧"] } }] }',
    };
  }

  const nodes: ExperimentalNode[] = [];
  const edges: ExperimentalEdge[] = [];
  const nodeIds = new Set<string>();
  const pushNode = (node: ExperimentalNode) => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };
  const pushEdge = (edge: ExperimentalEdge) => {
    if (edges.some((e) => e.from === edge.from && e.to === edge.to && e.type === edge.type)) return;
    edges.push(edge);
  };

  sections.forEach((sec, secIdx) => {
    const week = sec.id ?? `W${String(secIdx + 1).padStart(2, '0')}`;
    const expId = `exp-${stableHash(`exp:${week}:${sec.title}`)}`;
    pushNode({ id: expId, type: 'experiment', label: sec.title, week });

    const perType = new Map<string, string[]>();
    for (const [rawKey, rawValue] of Object.entries(sec.fields)) {
      const key = canonicalFieldKey(rawKey, input.fieldMap);
      if (!key) continue;
      const values = fieldValues(rawValue);
      if (values.length === 0) continue;
      perType.set(key, [...(perType.get(key) ?? []), ...values]);
    }

    // 值级实体 + 关系（step 保序：order 1 起）
    const valueId = (type: string, value: string) =>
      `${type}-${stableHash(`${week}:${type}:${value}`)}`;
    const link = (type: ExperimentalEntityType, edgeType: ExperimentalEdgeType, direction: 'out' | 'in' = 'out') => {
      const values = perType.get(type === 'step' ? 'step' : type) ?? [];
      values.forEach((value, order) => {
        const id = valueId(type, value);
        pushNode({
          id, type, label: value, week,
          ...(type === 'step' ? { order: order + 1 } : {}),
        });
        if (direction === 'out') pushEdge({ from: expId, to: id, type: edgeType, ...(type === 'step' ? { order: order + 1 } : {}) });
        else pushEdge({ from: id, to: expId, type: edgeType });
      });
    };
    link('standard', 'based_on');
    link('indicator', 'measures');
    link('instrument', 'uses');
    link('output', 'produces');
    link('qc', 'has_qc');
    link('difficulty', 'difficulty_of', 'in');
    link('sample', 'uses'); // 样品经 uses 关联（采样对象）
    link('step', 'step_order'); // 实验 → 各操作步骤（带 order）
    // 操作链保序：step 节点间 step_order 链
    const steps = perType.get('step') ?? [];
    for (let k = 0; k + 1 < steps.length; k++) {
      pushEdge({ from: valueId('step', steps[k]), to: valueId('step', steps[k + 1]), type: 'step_order', order: k + 1 });
    }
  });

  const byType: Record<string, number> = {};
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;

  return {
    skillId: 'extract_knowledge_graph',
    level: 'full',
    data: {
      schemaVersion: EXPERIMENTAL_GRAPH_SCHEMA_VERSION,
      graphType: 'experimental',
      nodes,
      edges,
      hierarchy: [],
      prerequisiteGraph: { nodes: nodes.map((n) => n.id), edges: [] },
      stats: { nodes: nodes.length, edges: edges.length, byType },
    },
    degradationNote: '',
  };
}
