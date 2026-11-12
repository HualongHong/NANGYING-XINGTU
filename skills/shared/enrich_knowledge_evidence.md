# 学术证据增强（enrich_knowledge_evidence）

## 技能 ID
`enrich_knowledge_evidence`

## 中文名
学术证据增强

## 类型
共享型（shared）

## 输入
- `graph`（与 queries 二选一）：课程知识图谱（`extract_knowledge_graph` / `fuse_knowledge_graphs` 输出）——取 `kind="concept"` 节点的 `label` 自动生成学术查询
- `queries`（与 graph 二选一）：自定义查询词字符串数组（非空字符串）
- `topK`（可选，默认 3）：每实体引用条数，1-10 整数
- `mode`（可选，默认 `agentic`）：`agentic` = 语义证据段检索（SciVerse semantic-search，含证据片段）；`meta` = 元数据检索（venue/year/doi 书目字段）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "挂接式学术证据增强：graph（或 queries）→ SciVerse 逐实体检索学术引用 → 归一化 references 合并可回图谱 academicEvidence。平台不可用（无 Token/SDK/网络/限流）时返回 degraded 且原图谱不动——主流程不中断，证据可后补"
inputs:
  - name: graph
    kind: object
    required: false
    hint: "与 queries 二选一：含 entities 数组的课程图谱（extract/fuse 输出），取 kind=concept 的 label 生成查询"
  - name: queries
    kind: array
    required: false
    hint: "与 graph 二选一：自定义查询词字符串数组（非空）；entityId 与查询词同值"
  - name: topK
    kind: number
    required: false
    hint: "每实体引用条数，1-10 整数，默认 3"
  - name: mode
    kind: string
    required: false
    hint: '"agentic"（默认）=语义证据段检索；"meta"=元数据检索（venue/year/doi 书目字段）'
```

## 输出
- `level: 'full'`：返回 `graph`（原样字段 + `academicEvidence: [{ entityId, query, references: [{ title, snippet?, docId?, uniqueId?, score?, venue?, year?, doi?, source: "sciverse" }] }]`）+ `stats`（查询实体数/有证据实体数/引用总数）
- `level: 'degraded'`：SciVerse 不可用（未配置 Token / SDK 未安装 / 网络或限流错误）时，原 `graph`/`queries` 原样回传 + `academicEvidence: []` + `platformNote` 说明原因与补齐路径——**调用方工作流不中断**

## 依赖
- 可选：SciVerse 平台（OpenDataLab 学术基座，官方 `sciverse` npm SDK，optionalDependencies + 动态 import）；Token 经 settings_card 平台服务区块或 `SCIVERSE_API_TOKEN` 配置

## 平台政策
- 密钥只经 keyProvider 惰性读取（secrets.json 命名密钥 `sciverseApiKey`，0600），永不回显/入日志/入反馈
- 单次调用查询数上限 20（平台额度保护，超出截断）；topK 上限 10
- SciVerse 起步额度免费；额度/速率以官网口径为准，429 限流返回 degraded

## 降级策略
无 SciVerse 时本插件全流程独立可跑：本技能返回 degraded 且原图谱不动（证据可后补重跑）；`graph`/`queries` 非法输入返回 `INVALID_INPUT` 结构化错误（含缺失项与最小示例）。

## 调用示例
```json
{
  "skillId": "enrich_knowledge_evidence",
  "inputs": { "graph": { "...": "extract_knowledge_graph 输出" }, "topK": 3, "mode": "agentic" }
}
```
无图谱时直连查询词：
```json
{
  "skillId": "enrich_knowledge_evidence",
  "inputs": { "queries": ["知识图谱构建", "慕课学习路径推荐"], "mode": "meta" }
}
```
