# 知识图谱融合（fuse_knowledge_graphs）

## 技能 ID
`fuse_knowledge_graphs`

## 中文名
知识图谱融合

## 类型
共享型（shared）

## 输入
- `graphs`：课程知识图谱数组（extract_knowledge_graph 的星图中枢 schema，≥1 份）
- `sources`：来源描述数组（与 graphs 等长）：`{ id, weight? }`；weight 默认 1（如"讲义权威 > 课件"场景可设 2）
- `pools`（可选）：各来源的完整候选池数组（与 graphs 等长，直接传 parse_course_material 输出的 knowledgePointCandidates）。**跨文档词表预融合**：在 ≥2 个来源候选池中出现（归一化标签）的术语即使未进各图 top-N，也提升进融合实体表——修复"各单元候选被专名占据、共享基础概念被挤出"的词表稀释问题
- `ctx`（可选）：宿主注入上下文，可携带 `llm` 对冲突候选做语义对齐
- `opts`（可选）：`{ cooccurrenceThreshold }` related 边融合后的共现阈值（默认 2）；`{ semanticClustering }` 语义聚类，默认 false——true 且有 ctx.llm 时，实体标签先经宿主 LLM 语义聚类、簇内归并到 canonical 再走确定性对齐阶梯

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "融合多份知识图谱，跨来源归并实体并对齐来源权重"
inputs:
  - name: graphs
    kind: array
    required: true
    hint: "知识图谱数组（各为 extract_knowledge_graph 输出；单图可直接传对象，自动包成数组）"
    producer: ["extract_knowledge_graph"]
  - name: sources
    kind: array
    required: true
    hint: "来源描述数组，与 graphs 等长：[{ id, weight? }]"
  - name: pools
    kind: array
    required: false
    hint: "各来源完整候选池数组（parse 输出的 knowledgePointCandidates），用于跨文档词表预融合"
    producer: ["parse_course_material"]
  - name: options
    kind: object
    required: false
    hint: "{ cooccurrenceThreshold?, semanticClustering? }"
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
- `graph`：融合后的课程知识图谱——实体跨来源归并（alignedGroups 中的规范标签），related 边按来源加权求和过重共现阈值，prerequisite 取来源并集，contains 边按来源保留在各自章节子树；章节树为多根森林（各来源章节并列）；ID 沿用确定性哈希（同标签同 ID），下游技能可安全引用。R12-2 起每个实体带 `fuseMeta: { primarySource, mergedSources }` 融合来源标记（主来源=规范标签的首次出现来源；mergedSources=归并的全部来源 id，确定性序）——fused 星图等下游按此区分来源侧，不与实体的章节/段落 `source` 出处语义冲突
- `report.alignedGroups`：归并实体组 `[{ canonicalLabel, memberLabels, sourceDistribution }]`（如"离心""离心操作"→"离心"，含来源分布）
- `report.conflicts`：未确定性归并的相近候选（留给 LLM/人工），`[{ labels, sources, reason }]`

## 依赖
- 无硬性外部依赖；`llm` 可选（用于冲突候选的语义对齐兜底与可选的语义聚类）

## 降级策略
实体对齐为确定性阶梯（归一化相等 → 互为子串 → 多来源投票），恒可用；LLM 语义对齐/语义聚类失败时如实返回并标记 degraded（聚类某批非法则该批跳过）；`graphs` 与 `sources` 数量不一致返回 unavailable。

## 调用示例
```json
{
  "skillId": "fuse_knowledge_graphs",
  "inputs": {
    "graphs": ["$unit-01.graph", "$unit-02.graph", "…"],
    "sources": [{ "id": "课件", "weight": 1 }, { "id": "讲义", "weight": 2 }]
  },
  "ctx": { "llm": "<宿主注入的 LLMProvider，可选>" }
}
```
