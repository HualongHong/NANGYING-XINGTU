/**
 * 星图渲染（renderStarmap）——core 纯 TS、零依赖、确定性布局。
 *
 * 布局规则（同图同输出，不依赖随机数）：
 *  - 章节按层级分布在内侧同心轨道上（level 1 最近，依次外推），层内等角分布；
 *  - 概念为外侧星点，按序取黄金角（137.508°）步进、同心细分环错开，避免重叠；
 *  - related 边按权重加粗连线（实线），prerequisite 边用虚线。
 *
 * R11-1 图谱类型识别（conceptual 路径逐字节不变）：
 *  - experimental（graphType 标记或八类实体 type 推断）：八类实体按类型分区环带，
 *    step_order 保持操作链的弧形连边；
 *  - industry（六类 nodeType 推断）：六类本体分区环带，五类关系各自线型
 *    （实线/虚线/点线/点划/长划区分 has/requires/drives）；
 *  - fused（混合型：无 type 概念节点 + 产业本体节点）：产业侧节点以橙色虚线边框
 *    与课程侧区分，各边沿用所属图谱线型；fuse 输出的 node.source 存在时图例标注来源。
 * 三类均带图例（类型中文名 + 计数；产业附线型样例；融合附来源侧区分）。
 * 输出 SVG 字符串；renderStarmapHtml 包一层自包含 HTML（内联样式，无外链）。
 */

import type { CourseKnowledgeGraph, HierarchySection } from './extractKnowledgeGraph.js';

const W = 900;
const H = 900;
const CX = W / 2;
const CY = H / 2;
const GOLDEN_ANGLE = 137.508;

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Point { x: number; y: number }

function polar(r: number, deg: number): Point {
  const rad = (deg * Math.PI) / 180;
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
}

function walk(sec: HierarchySection, out: HierarchySection[]): void {
  out.push(sec);
  for (const c of sec.children) walk(c, out);
}

// ---------- R11-1：图谱类型识别与归一 ----------

export type StarmapKind = 'conceptual' | 'experimental' | 'industry' | 'fused';

const INDUSTRY_TYPES = ['industry', 'occupation', 'workTask', 'skill', 'tool', 'trend'] as const;
const EXPERIMENTAL_TYPES = ['experiment', 'standard', 'sample', 'indicator', 'instrument', 'step', 'qc', 'output', 'difficulty'] as const;

const INDUSTRY_TYPE_NAMES: Record<string, string> = {
  industry: '产业/环节', occupation: '岗位', workTask: '工作任务',
  skill: '技能要求', tool: '工具技术', trend: '趋势政策',
};
const EXPERIMENTAL_TYPE_NAMES: Record<string, string> = {
  experiment: '实验', standard: '标准', sample: '样品', indicator: '指标',
  instrument: '仪器', step: '操作步骤', qc: '质控', output: '产出', difficulty: '难点',
};

const INDUSTRY_COLORS: Record<string, string> = {
  industry: '#e8c66a', occupation: '#ff9f6e', workTask: '#d98cb3',
  skill: '#7fd4ff', tool: '#9fe8a9', trend: '#c586c0',
};
const EXPERIMENTAL_COLORS: Record<string, string> = {
  experiment: '#e8c66a', standard: '#9fe8a9', sample: '#d9c98c', indicator: '#7fd4ff',
  instrument: '#9fb3d9', step: '#ff9f6e', qc: '#c586c0', output: '#6ee8d8', difficulty: '#e86e6e',
};

/** 归一节点（章节外的实体节点） */
interface SNode {
  id: string;
  label: string;
  /** 本体/实体类型（conceptual 为 'concept'） */
  family: string;
  order: number;
  /** 融合图来源标记（fuse/extract 的 source 字段存在时携带） */
  origin?: string;
}

interface SEdge { from: string; to: string; type: string; weight: number }

interface NormalizedGraph {
  kind: StarmapKind;
  nodes: SNode[];
  edges: SEdge[];
  sections: HierarchySection[];
  /** 类型中文名表（legend 用） */
  typeNames: Record<string, string>;
  typeColors: Record<string, string>;
  /** 融合图：按来源侧分组的节点数 */
  originCounts: Record<string, number>;
}

function isIndustryType(t: string | undefined): boolean {
  return !!t && (INDUSTRY_TYPES as readonly string[]).includes(t);
}
function isExperimentalType(t: string | undefined): boolean {
  return !!t && (EXPERIMENTAL_TYPES as readonly string[]).includes(t);
}

/** 图谱类型识别：graphType 标记优先，其次按 nodeType/type 推断；混合型判 fused */
export function detectStarmapKind(graph: unknown): StarmapKind {
  const g = graph as { graphType?: string; entities?: Array<Record<string, unknown>>; nodes?: Array<Record<string, unknown>> };
  if (g?.graphType === 'experimental') return 'experimental';
  const list = Array.isArray(g?.entities) ? g.entities : Array.isArray(g?.nodes) ? g.nodes : [];
  let industry = 0;
  let experimental = 0;
  let plain = 0;
  for (const n of list) {
    const t = typeof n?.nodeType === 'string' ? n.nodeType : typeof n?.type === 'string' ? n.type : undefined;
    if (isIndustryType(t)) industry++;
    else if (isExperimentalType(t)) experimental++;
    else plain++;
  }
  if (industry > 0 && (plain > 0 || experimental > 0)) return 'fused';
  if (industry > 0) return 'industry';
  if (experimental > 0) return 'experimental';
  return 'conceptual';
}

function normalizeGraph(graph: CourseKnowledgeGraph): NormalizedGraph {
  const kind = detectStarmapKind(graph);
  const g = graph as unknown as {
    hierarchy?: HierarchySection[];
    entities?: Array<Record<string, unknown>>;
    nodes?: Array<Record<string, unknown>>;
    relations?: Array<Record<string, unknown>>;
    edges?: Array<Record<string, unknown>>;
  };
  const sections: HierarchySection[] = [];
  for (const root of g.hierarchy ?? []) walk(root, sections);
  const rawList = (Array.isArray(g.entities) ? g.entities : Array.isArray(g.nodes) ? g.nodes : []);
  const nodes: SNode[] = [];
  const seen = new Set<string>();
  rawList.forEach((n, i) => {
    const id = typeof n?.id === 'string' ? n.id : `n-${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    const family = typeof n?.nodeType === 'string' ? n.nodeType
      : typeof n?.type === 'string' ? n.type
      : 'concept';
    const origin = (() => {
      const fm = n?.fuseMeta as { primarySource?: unknown } | undefined;
      if (fm && typeof fm.primarySource === 'string' && fm.primarySource) return fm.primarySource; // R12-2：fuse 来源标记优先
      return (n?.source && typeof (n.source as { posting?: string }).posting === 'string') ? '产业侧（JD）'
        : n?.source ? '课程侧' : undefined;
    })();
    nodes.push({
      id,
      label: typeof n?.label === 'string' ? n.label : id,
      family,
      order: typeof n?.order === 'number' ? n.order : i,
      ...(origin ? { origin } : {}),
    });
  });
  const rawEdges = (Array.isArray(g.relations) ? g.relations : Array.isArray(g.edges) ? g.edges : []);
  const edges: SEdge[] = rawEdges
    .filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string')
    .map((e) => ({
      from: e.from as string,
      to: e.to as string,
      type: typeof e.type === 'string' ? e.type : 'related',
      weight: typeof e.weight === 'number' ? e.weight : 1,
    }));
  const originCounts: Record<string, number> = {};
  for (const n of nodes) {
    if (!n.origin) continue;
    originCounts[n.origin] = (originCounts[n.origin] ?? 0) + 1;
  }
  const typeNames = kind === 'industry' || (kind === 'fused' && nodes.some((n) => isIndustryType(n.family)))
    ? INDUSTRY_TYPE_NAMES : kind === 'experimental' ? EXPERIMENTAL_TYPE_NAMES : {};
  const typeColors = kind === 'experimental' ? EXPERIMENTAL_COLORS : INDUSTRY_COLORS;
  return { kind, nodes, edges, sections, typeNames, typeColors, originCounts };
}

// ---------- 既有 conceptual 渲染（逐字节不变） ----------

function renderConceptualSvg(graph: CourseKnowledgeGraph): string {
  const sections: HierarchySection[] = [];
  for (const root of graph.hierarchy) walk(root, sections);
  const concepts = graph.entities;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="课程星图">`,
    `<rect width="${W}" height="${H}" fill="#0b1026"/>`,
    `<style>text{font-family:"Microsoft YaHei","PingFang SC",sans-serif;fill:#dfe6f3}.sec{font-size:12px}.con{font-size:10px;fill:#9fb3d9}.edge-r{stroke:#5b8def;stroke-opacity:.45}.edge-p{stroke:#c586c0;stroke-opacity:.5;stroke-dasharray:5 4}</style>`,
  );

  if (sections.length === 0 && concepts.length === 0) {
    parts.push(`<text x="${CX}" y="${CY}" text-anchor="middle" font-size="16">空图谱</text>`);
    parts.push('</svg>');
    return parts.join('\n');
  }

  // 背景星尘（确定性伪随机：固定步长散布）
  for (let i = 0; i < 60; i++) {
    const p = polar(30 + ((i * 137) % 400), i * 61.8);
    parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="0.8" fill="#31406b"/>`);
  }

  // 概念星点位置（黄金角 + 细分环）
  const conceptPos = new Map<string, Point>();
  concepts.forEach((c, order) => {
    const ring = order % 4;
    const r = 320 + ring * 26;
    const angle = order * GOLDEN_ANGLE;
    conceptPos.set(c.id, polar(r, angle));
  });

  // 边：related 实线 / prerequisite 虚线
  for (const e of graph.relations) {
    const a = conceptPos.get(e.from);
    const b = conceptPos.get(e.to);
    if (!a || !b) continue;
    if (e.type === 'related') {
      const w = Math.min(1 + e.weight * 0.5, 4).toFixed(1);
      parts.push(`<line class="edge-r" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke-width="${w}"/>`);
    } else if (e.type === 'prerequisite') {
      parts.push(`<line class="edge-p" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke-width="1.2"/>`);
    }
  }

  // 章节轨道与标签
  const byLevel = new Map<number, HierarchySection[]>();
  for (const s of sections) {
    byLevel.set(s.level, [...(byLevel.get(s.level) ?? []), s]);
  }
  for (const [level, list] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    const r = 110 + (level - 1) * 90;
    parts.push(`<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="#22315c" stroke-width="1" stroke-dasharray="2 6"/>`);
    list.forEach((s, i) => {
      const angle = (i * 360) / list.length + level * 30;
      const p = polar(r, angle);
      parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#e8c66a"/>`);
      parts.push(`<text class="sec" x="${p.x.toFixed(1)}" y="${(p.y - 9).toFixed(1)}" text-anchor="middle">${escapeXml(s.title)}</text>`);
    });
  }

  // 概念星点
  for (const c of concepts) {
    const p = conceptPos.get(c.id)!;
    parts.push(
      `<g><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.4" fill="#7fd4ff"/>` +
      `<title>${escapeXml(c.label)}</title>` +
      `<text class="con" x="${p.x.toFixed(1)}" y="${(p.y + 15).toFixed(1)}" text-anchor="middle">${escapeXml(c.label)}</text></g>`,
    );
  }

  // 中心
  parts.push(`<circle cx="${CX}" cy="${CY}" r="10" fill="#e8c66a"/>`);
  parts.push(`<text x="${CX}" y="${CY - 18}" text-anchor="middle" font-size="13">囊萤星图</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

// ---------- R11-1：类型分区渲染（experimental / industry / fused） ----------

/** 产业五类关系线型（has/requires/drives 各自区分） */
const INDUSTRY_EDGE_STYLES: Record<string, { cls: string; css: string; name: string }> = {
  industry_has_occupation: { cls: 'e-iho', css: 'stroke:#e8c66a;stroke-opacity:.7;stroke-width:1.4', name: '产业→岗位' },
  occupation_has_task: { cls: 'e-oht', css: 'stroke:#d98cb3;stroke-opacity:.6;stroke-width:1.2;stroke-dasharray:6 4', name: '岗位→任务' },
  task_requires_skill: { cls: 'e-trs', css: 'stroke:#7fd4ff;stroke-opacity:.6;stroke-width:1.2;stroke-dasharray:1 4;stroke-linecap:round', name: '任务→技能' },
  skill_uses_tool: { cls: 'e-sut', css: 'stroke:#9fe8a9;stroke-opacity:.6;stroke-width:1.1;stroke-dasharray:8 3 2 3', name: '技能→工具' },
  trend_drives_skill: { cls: 'e-tds', css: 'stroke:#c586c0;stroke-opacity:.7;stroke-width:1.4;stroke-dasharray:12 5', name: '趋势→技能' },
};

const EXPERIMENTAL_EDGE_CSS = 'stroke:#5b6c96;stroke-opacity:.5;stroke-width:1.1';
const STEP_EDGE_CSS = 'stroke:#ff9f6e;stroke-opacity:.75;stroke-width:1.6;fill:none';
const FUSED_GENERIC_CSS = 'stroke:#5b8def;stroke-opacity:.4;stroke-width:1.2';

const KIND_TITLES: Record<StarmapKind, string> = {
  conceptual: '课程星图', experimental: '实验星图', industry: '产业星图', fused: '融合星图',
};

function renderTypedSvg(g: NormalizedGraph): string {
  // 类型出场序（确定性）：按节点 order 首次出现的 family 顺序
  const families: string[] = [];
  for (const n of [...g.nodes].sort((a, b) => a.order - b.order)) {
    if (!families.includes(n.family)) families.push(n.family);
  }
  const T = Math.max(families.length, 1);
  const perFamily = new Map<string, SNode[]>();
  for (const f of families) perFamily.set(f, g.nodes.filter((n) => n.family === f));

  // 分区环带：每类型一个等角扇区，内部分层同心环
  const pos = new Map<string, Point>();
  const sectorOf = new Map<string, number>();
  families.forEach((f, i) => sectorOf.set(f, i));
  const PER_RING = 5;
  families.forEach((f) => {
    const list = [...(perFamily.get(f) ?? [])].sort((a, b) => a.order - b.order);
    const sec = sectorOf.get(f)!;
    list.forEach((n, i) => {
      const ring = Math.floor(i / PER_RING);
      const r = 165 + ring * 58;
      const slotDeg = 360 / T;
      const angle = sec * slotDeg + ((i % PER_RING) + 1) * (slotDeg / (Math.min(list.length, PER_RING) + 1));
      pos.set(n.id, polar(r, angle));
    });
  });

  const parts: string[] = [];
  const edgeCss = [
    ...Object.values(INDUSTRY_EDGE_STYLES).map((s) => `.${s.cls}{${s.css}}`),
    `.e-x{${EXPERIMENTAL_EDGE_CSS}}`,
    `.e-step{${STEP_EDGE_CSS}}`,
    `.e-fg{${FUSED_GENERIC_CSS}}`,
  ].join('');
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${KIND_TITLES[g.kind]}">`,
    `<rect width="${W}" height="${H}" fill="#0b1026"/>`,
    `<style>text{font-family:"Microsoft YaHei","PingFang SC",sans-serif;fill:#dfe6f3}.nd{font-size:10px;fill:#c6d4f0}.leg{font-size:11px}.legchip{stroke-width:1}${edgeCss ? ` ${edgeCss}` : ''}</style>`,
  );

  if (g.nodes.length === 0 && g.sections.length === 0) {
    parts.push(`<text x="${CX}" y="${CY}" text-anchor="middle" font-size="16">空图谱</text>`);
    parts.push('</svg>');
    return parts.join('\n');
  }

  // 背景星尘（与 conceptual 同一确定性散布）
  for (let i = 0; i < 60; i++) {
    const p = polar(30 + ((i * 137) % 400), i * 61.8);
    parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="0.8" fill="#31406b"/>`);
  }

  // 扇区分隔弧（虚线圈）
  const maxRing = Math.max(0, ...families.map((f) => Math.floor(((perFamily.get(f)?.length ?? 1) - 1) / PER_RING)));
  for (let ring = 0; ring <= maxRing; ring++) {
    parts.push(`<circle cx="${CX}" cy="${CY}" r="${165 + ring * 58}" fill="none" stroke="#22315c" stroke-width="1" stroke-dasharray="2 6"/>`);
  }

  // 边
  const arc = (a: Point, b: Point): string => {
    // 弧形连边：控制点沿角平分线外推，保持操作链的弧线感
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = mx - CX;
    const dy = my - CY;
    const len = Math.hypot(dx, dy) || 1;
    const k = 1.22;
    return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${(CX + dx * k).toFixed(1)},${(CY + dy * k).toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  };
  const drawnCls = new Set<string>();
  for (const e of g.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    if (g.kind === 'experimental') {
      if (e.type === 'step_order') {
        drawnCls.add('e-step');
        parts.push(`<path class="e-step" d="${arc(a, b)}"/>`);
      } else {
        drawnCls.add('e-x');
        parts.push(`<line class="e-x" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`);
      }
    } else if (g.kind === 'industry') {
      const st = INDUSTRY_EDGE_STYLES[e.type];
      if (!st) continue;
      drawnCls.add(st.cls);
      const w = e.type === 'task_requires_skill' ? '' : ` stroke-width="${Math.min(1 + e.weight * 0.3, 2.4).toFixed(1)}"`;
      parts.push(`<line class="${st.cls}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"${w}/>`);
    } else {
      // fused：产业关系名沿用产业线型，其余细实线
      const st = INDUSTRY_EDGE_STYLES[e.type];
      if (st) {
        drawnCls.add(st.cls);
        parts.push(`<line class="${st.cls}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`);
      } else {
        drawnCls.add('e-fg');
        parts.push(`<line class="e-fg" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"${e.type === 'prerequisite' ? ' stroke-dasharray="5 4"' : ''}/>`);
      }
    }
  }

  // 节点（融合图：产业侧节点橙色虚线边框区分课程侧）
  for (const n of g.nodes) {
    const p = pos.get(n.id)!;
    const fill = g.typeColors[n.family] ?? '#7fd4ff';
    const isIndustrySide = g.kind === 'fused' && isIndustryType(n.family);
    const border = isIndustrySide ? ' stroke="#ff9f6e" stroke-width="1.6" stroke-dasharray="3 2"' : '';
    parts.push(
      `<g><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.2" fill="${fill}"${border}/>` +
      `<title>${escapeXml(n.label)}${n.origin ? `（${n.origin}）` : ''}</title>` +
      `<text class="nd" x="${p.x.toFixed(1)}" y="${(p.y + 16).toFixed(1)}" text-anchor="middle">${escapeXml(n.label)}</text></g>`,
    );
  }

  // 图例：类型中文名 + 计数（产业附线型样例；融合附来源侧区分）
  const legendRows: string[] = [];
  const chip = (f: string) => `<circle cx="14" cy="0" r="4.2" fill="${g.typeColors[f] ?? '#7fd4ff'}"/>`;
  const typeCount = new Map<string, number>();
  for (const n of g.nodes) typeCount.set(n.family, (typeCount.get(n.family) ?? 0) + 1);
  const rowOf = (dy: number, inner: string) => `<g transform="translate(20,${dy})">${inner}</g>`;
  let ly = 40;
  for (const f of families) {
    const name = g.typeNames[f] ?? EXPERIMENTAL_TYPE_NAMES[f] ?? INDUSTRY_TYPE_NAMES[f] ?? f;
    legendRows.push(rowOf(ly, `${chip(f)}<text class="leg" x="26" y="4">${escapeXml(name)} ×${typeCount.get(f)}</text>`));
    ly += 18;
  }
  if (g.kind === 'industry' || g.kind === 'fused') {
    ly += 6;
    for (const [type, st] of Object.entries(INDUSTRY_EDGE_STYLES)) {
      if (!drawnCls.has(st.cls)) continue;
      const sample = `<line class="${st.cls}" x1="6" y1="0" x2="34" y2="0" style="${st.css.replace(/stroke-opacity:[.\d]+;?/g, '')}"/>`;
      legendRows.push(rowOf(ly, `${sample}<text class="leg" x="42" y="4">${escapeXml(st.name)}</text>`));
      ly += 16;
    }
  }
  if (g.kind === 'experimental') {
    ly += 6;
    if (drawnCls.has('e-step')) {
      legendRows.push(rowOf(ly, `<path class="e-step" d="M6,0 Q20,-10 34,0"/><text class="leg" x="42" y="4">操作链（step_order）</text>`));
      ly += 16;
    }
    if (drawnCls.has('e-x')) {
      legendRows.push(rowOf(ly, `<line class="e-x" x1="6" y1="0" x2="34" y2="0"/><text class="leg" x="42" y="4">其他关系</text>`));
      ly += 16;
    }
  }
  if (g.kind === 'fused' && Object.keys(g.originCounts).length > 0) {
    ly += 6;
    for (const [origin, count] of Object.entries(g.originCounts)) {
      legendRows.push(rowOf(ly, `<circle cx="14" cy="0" r="4.2" fill="none" stroke="#ff9f6e" stroke-dasharray="3 2" stroke-width="1.6"/><text class="leg" x="26" y="4">${escapeXml(origin)} ×${count}</text>`));
      ly += 16;
    }
  }
  parts.push(`<g class="legend"><rect x="10" y="12" width="168" height="${ly - 22}" fill="#101838" fill-opacity=".85" stroke="#22315c" rx="6"/>${legendRows.join('')}</g>`);

  // 中心与标题
  parts.push(`<circle cx="${CX}" cy="${CY}" r="10" fill="#e8c66a"/>`);
  parts.push(`<text x="${CX}" y="${CY - 18}" text-anchor="middle" font-size="13">${KIND_TITLES[g.kind]}</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

/** 渲染星图为 SVG 字符串（确定性；conceptual 路径与 R10 前逐字节一致） */
export function renderStarmapSvg(graph: CourseKnowledgeGraph): string {
  if (detectStarmapKind(graph) === 'conceptual') return renderConceptualSvg(graph);
  return renderTypedSvg(normalizeGraph(graph));
}

/** 包一层自包含 HTML（内联样式，无外链） */
export function renderStarmapHtml(graph: CourseKnowledgeGraph, title = '课程星图'): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(title)}</title>
<style>
body{margin:0;background:#070b1c;color:#dfe6f3;font-family:"Microsoft YaHei","PingFang SC",sans-serif}
header{padding:16px 24px;font-size:18px;letter-spacing:2px}
main{display:flex;justify-content:center}
svg{max-width:100vw;max-height:calc(100vh - 80px)}
</style>
</head>
<body>
<header>${escapeXml(title)}</header>
<main>
${renderStarmapSvg(graph)}
</main>
</body>
</html>
`;
}
