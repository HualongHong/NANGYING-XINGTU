/**
 * 知识图谱导出格式（R5-3，反馈 b P1-5）：mermaid / graphml / csv / jsonld。
 *
 * 确定性纯函数：同图同串。默认 json 由 extract 原样输出（不经本模块）。
 * - mermaid：flowchart LR，先修链为主（prerequisite 实线箭头），related 虚线；
 *   节点数 >200 截断并注明。
 * - graphml：标准 XML（yfiles 无关的最小 schema：node/edge 数据字段）。
 * - csv：entities 段 + relations 段（Excel 可直接打开；逗号/引号转义）。
 * - jsonld：@context + nodes/edges 数组。
 */
import type { CourseKnowledgeGraph, KnowledgeGraphEdge, KnowledgeGraphNode } from './extractKnowledgeGraph.js';

export type GraphOutputFormat = 'json' | 'mermaid' | 'graphml' | 'csv' | 'jsonld';

export const MERMAID_MAX_NODES = 200;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 概念实体（kind=concept）；无则退回全部节点 */
function conceptNodes(graph: CourseKnowledgeGraph): KnowledgeGraphNode[] {
  const concepts = graph.entities.filter((n) => n.kind === 'concept');
  return concepts.length > 0 ? concepts : graph.entities;
}

/** 节点标签 → mermaid id（确定性短哈希，避免中文标点问题） */
function mermaidId(node: KnowledgeGraphNode): string {
  let h = 5381;
  for (let i = 0; i < node.id.length; i++) h = ((h << 5) + h + node.id.charCodeAt(i)) | 0;
  return `n${(h >>> 0).toString(36)}`;
}

export function toMermaid(graph: CourseKnowledgeGraph): string {
  const nodes = conceptNodes(graph);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const truncated = nodes.length > MERMAID_MAX_NODES;
  const shown = truncated ? nodes.slice(0, MERMAID_MAX_NODES) : nodes;
  const shownIds = new Set(shown.map((n) => n.id));
  const lines: string[] = ['flowchart LR'];
  for (const n of shown) {
    lines.push(`  ${mermaidId(n)}["${esc(n.label)}"]`);
  }
  let edgeCount = 0;
  for (const e of graph.relations) {
    if (!shownIds.has(e.from) || !shownIds.has(e.to)) continue;
    if (e.type === 'prerequisite') {
      lines.push(`  ${mermaidIdById(graph, e.from)} --> ${mermaidIdById(graph, e.to)}`);
      edgeCount += 1;
    } else if (e.type === 'related') {
      lines.push(`  ${mermaidIdById(graph, e.from)} -.-> ${mermaidIdById(graph, e.to)}`);
      edgeCount += 1;
    }
    void nodeIds;
  }
  if (truncated) {
    lines.push(`  %% 截断：节点 ${nodes.length} > ${MERMAID_MAX_NODES}，仅前 ${MERMAID_MAX_NODES} 个`);
  }
  if (edgeCount === 0) lines.push('  %% 无可视化关系边（先修/相关）');
  return lines.join('\n');
}

/** 按节点 id 求 mermaid id（edges 引用用；不在 entities 时退回哈希） */
function mermaidIdById(graph: CourseKnowledgeGraph, id: string): string {
  const n = graph.entities.find((x) => x.id === id);
  return n ? mermaidId(n) : (() => {
    let h = 5381;
    for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
    return `n${(h >>> 0).toString(36)}`;
  })();
}

export function toGraphml(graph: CourseKnowledgeGraph): string {
  const nodes = conceptNodes(graph);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodeXml = nodes
    .map(
      (n) =>
        `  <node id="${esc(n.id)}"><data key="label">${esc(n.label)}</data>` +
        `<data key="kind">${n.kind}</data><data key="order">${n.order}</data>` +
        `${n.confidence !== undefined ? `<data key="confidence">${n.confidence}</data>` : ''}</node>`,
    )
    .join('\n');
  const edgeXml = graph.relations
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map(
      (e, i) =>
        `  <edge id="e${i}" source="${esc(e.from)}" target="${esc(e.to)}">` +
        `<data key="type">${e.type}</data><data key="weight">${e.weight}</data></edge>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
<key id="label" for="node" attr.name="label" attr.type="string"/>
<key id="kind" for="node" attr.name="kind" attr.type="string"/>
<key id="order" for="node" attr.name="order" attr.type="int"/>
<key id="confidence" for="node" attr.name="confidence" attr.type="double"/>
<key id="type" for="edge" attr.name="type" attr.type="string"/>
<key id="weight" for="edge" attr.name="weight" attr.type="int"/>
<graph id="nangying" edgedefault="directed">
${nodeXml}
${edgeXml}
</graph>
</graphml>`;
}

export function toCsv(graph: CourseKnowledgeGraph): string {
  const nodes = conceptNodes(graph);
  const entityRows = [
    'id,label,kind,order,confidence,sectionOrder,paragraphs',
    ...nodes.map((n) =>
      [
        csvCell(n.id),
        csvCell(n.label),
        n.kind,
        n.order,
        n.confidence ?? '',
        n.source ? csvCell(n.source.sectionOrder.join('|')) : '',
        n.source ? csvCell(n.source.paragraphIndexes.join('|')) : '',
      ].join(','),
    ),
  ];
  const nodeIds = new Set(nodes.map((n) => n.id));
  const relationRows = [
    'id,from,to,type,weight,provenance',
    ...graph.relations
      .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
      .map((e: KnowledgeGraphEdge) =>
        [csvCell(e.id), csvCell(e.from), csvCell(e.to), e.type, e.weight, e.provenance ?? 'heuristic'].join(','),
      ),
  ];
  return `# entities.csv\n${entityRows.join('\n')}\n\n# relations.csv\n${relationRows.join('\n')}`;
}

export function toJsonLd(graph: CourseKnowledgeGraph): string {
  const nodes = conceptNodes(graph);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const doc = {
    '@context': {
      '@vocab': 'https://nangying-starmap.dev/schema/graph#',
      label: 'https://nangying-starmap.dev/schema/graph#label',
      edgeType: 'https://nangying-starmap.dev/schema/graph#edgeType',
      weight: 'https://schema.org/weight',
    },
    '@type': 'CourseKnowledgeGraph',
    schemaVersion: graph.schemaVersion ?? '1.0',
    nodes: nodes.map((n) => ({
      '@id': n.id,
      '@type': n.kind === 'concept' ? 'Concept' : 'Section',
      label: n.label,
      order: n.order,
      ...(n.confidence !== undefined ? { confidence: n.confidence } : {}),
      ...(n.source ? { source: n.source } : {}),
    })),
    edges: graph.relations
      .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
      .map((e) => ({
        '@id': e.id,
        from: e.from,
        to: e.to,
        edgeType: e.type,
        weight: e.weight,
        provenance: e.provenance ?? 'heuristic',
      })),
  };
  return JSON.stringify(doc, null, 2);
}

/** 统一入口：按格式导出（json 不经过本模块，调用方原样返回图谱） */
export function exportGraph(graph: CourseKnowledgeGraph, format: GraphOutputFormat): string | null {
  switch (format) {
    case 'mermaid': return toMermaid(graph);
    case 'graphml': return toGraphml(graph);
    case 'csv': return toCsv(graph);
    case 'jsonld': return toJsonLd(graph);
    default: return null;
  }
}
