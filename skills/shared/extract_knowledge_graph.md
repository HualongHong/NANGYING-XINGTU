# 知识图谱提取（extract_knowledge_graph）

## 技能 ID
`extract_knowledge_graph`

## 中文名
知识图谱提取

## 类型
共享型（shared）

## 输入
- `knowledgeGraph`（即 parse_course_material 的完整输出：章节 + 段落 + 知识点候选），字段为 `structuredContent`；上游文本解码归适配层，core 层协议无关。
- `graphType`（可选）：`'conceptual'`（概念层，默认）| `'experimental'`（实验型图谱，反馈 b P0-4）。
- `sections` + `fieldMap`（experimental 模式输入）：章节 + 字段形态 `[{ id?, title, fields }]`，键名归一到 标准/样品/指标/仪器/操作链/质控/产出/难点 八类（别名自动识别，自定义键名经 `fieldMap` 映射）。
- `ctx`（可选）：宿主注入上下文，可携带 `llm`（`LLMProvider`）启用知识点级关系精炼。
- `opts`（可选）：`{ cooccurrenceThreshold }` 共现相关边阈值，默认 2；`{ candidateLimit }` 建图用的候选上限，默认按弹性规则取值（基础 20、每 4000 字 +1、封顶 60），传 `Infinity` 使用 parse 输出的完整候选池（跨文档融合推荐）；`{ semanticClustering }` 语义聚类，默认 false——true 且有 ctx.llm 时，建图候选先经宿主 LLM 语义聚类（分批 ≤100、canonical 归一化并簇），簇内标签归并到 canonical 再走上层归并（如 比色皿/比色杯/比色池 → 比色）。

## 实验型图谱（graphType=experimental）
实体类型：`experiment`（实验）/ `standard` / `sample` / `indicator` / `instrument` / `step`（带 order，操作链保序）/ `qc` / `output` / `difficulty`。
关系：`based_on`（实验依据标准）、`measures`（测定指标）、`uses`（使用仪器/样品）、`step_order`（操作链保序边）、`produces`（产出数据）、`has_qc`（质控）、`difficulty_of`（难点归属实验）。
输出：`{ schemaVersion, graphType: 'experimental', nodes, edges, hierarchy: [], prerequisiteGraph, stats: { nodes, edges, byType } }`；同输入同输出（确定性 ID）。

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "把 parse 的结构化内容抽成课程知识图谱（实体/关系/层级/先修图）"
inputs:
  - name: structuredContent
    kind: object
    required: true
    hint: "parse_course_material 输出中的 data 对象（含 structuredSections/paragraphs/knowledgePointCandidates 数组）；JSON 字符串会自动解析"
    producer: ["parse_course_material"]
  - name: options
    kind: object
    required: false
    hint: "{ cooccurrenceThreshold?, candidateLimit?, semanticClustering? }；semanticClustering=true 且有 LLM 时先做语义聚类归并"
  - name: graphType
    kind: string
    required: false
    hint: "图谱类型：'conceptual'（概念层，默认）|'experimental'（实验型：sections+fields 字段形态）"
  - name: sections
    kind: array
    required: false
    hint: "experimental 模式输入：[{ id?, title, fields: { 标准/样品/指标/仪器/操作链/质控/产出/难点: 值 } }]（键名可经 fieldMap 映射）"
  - name: fieldMap
    kind: object
    required: false
    hint: "字段键名映射：{ 用户键: standard|sample|indicator|instrument|step|qc|output|difficulty }"
  - name: outputFormat
    kind: string
    required: false
    hint: "图谱导出格式：'json'（默认，原样）|'mermaid'（flowchart，先修链为主，>200 节点截断注明）|'graphml'|'csv'（entities+relations 两段）|'jsonld'；结果在 data.output"
  - name: async
    kind: boolean
    required: false
    hint: "true 时提交异步作业、毫秒级返回 jobId，用 manage_async_tasks 轮询（不受宿主超时限制；LLM 阶段无同步预算上限）"
  - name: progress
    kind: boolean
    required: false
    hint: "true 请求进度回报：异步作业进度写快照；MCP 通道经 progress 通知推送"
```
## 输出
课程知识图谱（星图中枢 schema）= 节点 + 边：
- `entities`：知识实体（知识点节点，来自候选标签归并去重 + **偏移重叠防线**：长度差 ≤2 且近乎完全的错开窗口对（重叠 ≥ min(长度)-3，5 字起判）归并到词频高者，清除滑窗碎片链；归并规则：互为子串且出现段落为子集，如"随机梯度下降"并入"梯度下降"；"监督学习"与"无监督学习"位置不子集，保留为两个概念）
- `relations`：全部关系边，类型枚举：`contains`（章节树父子）、`related`（知识点段落共现，weight=共现次数）、`prerequisite`（章节顺序链 + 知识点首次出现顺序）
- `hierarchy`：章节层级组织（嵌套树，栈式按 level 归位）
- `prerequisiteGraph`：先修/后继关系子图（含 Kahn 拓扑排序 `topoOrder`，供学习路径与课程结构设计使用）
- `schemaVersion`：图谱 schema 版本（当前 `"1.2"`；fuse 融合图沿用来源最高版本，旧快照缺省视为 "1.0"）

节点与边均带稳定确定性 ID（djb2 哈希，非随机）：章节 `sec-<hash>`、知识点 `con-<hash>`、边 `edge-<hash(from->to:type)>`，下游技能可安全引用。章节节点 level=章节层级（1 起），知识点节点 level=0（概念层）。

**实体可核验字段（schemaVersion 1.2 起，反馈 b P1-3）**：每个概念实体带
- `source`：`{ sectionOrder: number[], paragraphIndexes: number[] }`——从哪些章节/段落抽取，教师可逐条定位原文；
- `confidence`：0–1 启发式置信度（`0.3 + 0.1·min(出现段落数,5) + 0.4·score/(score+20)`，确定性归一，仅供核验排序）；
- 关系边带 `provenance`：`heuristic`（启发式）/ `llm`（LLM 精炼关系），LLM 精炼失败回落启发式时全图保持 heuristic。

## 依赖
- `llm`：大语言模型（可选；注入时对知识点级 related/prerequisite 关系做精炼归并，替换启发式知识点级关系）
- `ner`：命名实体识别（可选，提升专名抽取精度，待接入）

## 降级策略
- 宿主注入的 LLM 精炼失败（返回非法内容或解析异常）时，自动回落启发式关系并标记 degraded。
- 语义聚类（semanticClustering=true）：LLM 某批返回非法 JSON → 该批跳过、其余批保留，整体标记 degraded 并注明；未注入 LLM 时聚类不生效（等价默认路径）。
- 输入为空时仅返回空图谱骨架并标记 degraded。
- 无 LLM/NER 时的默认启发式输出已超出"仅标题层级"：包含章节树、共现相关与顺序先修边（见上文），属于约定行为扩展。

## 调用示例
```json
{
  "skillId": "extract_knowledge_graph",
  "inputs": {
    "structuredContent": "$parse_course_material"
  },
  "ctx": {
    "llm": "<宿主注入的 LLMProvider，可选>"
  }
}
```
