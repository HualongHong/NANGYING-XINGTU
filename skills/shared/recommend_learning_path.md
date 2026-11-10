# 学习路径推荐（recommend_learning_path）

## 技能 ID
`recommend_learning_path`

## 中文名
学习路径推荐

## 类型
共享型（shared）

## 输入
- `knowledgeGraph`：课程知识图谱（extract_knowledge_graph 完整输出，消费 prerequisiteGraph.topoOrder 与层级树）
- `profile`：学习者画像（契约中 learnerProfile 的结构化形态）`{ knownConceptIds?: string[]; goalConceptIds?: string[]; availableMinutes?: number }`——已掌握知识点（剪枝）、目标知识点（先修闭包裁剪）、可用分钟数（预算截断）
- `ctx`（可选）：宿主注入上下文，可携带 `llm`（`LLMProvider`）为每步生成 reason 说明

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "结合知识图谱与学习者画像生成个性化学习路径"
inputs:
  - name: graph
    kind: object
    required: true
    aliases: ["knowledgeGraph"]
    hint: "extract/fuse 的输出（消费 prerequisiteGraph 与层级树）"
    producer: ["extract_knowledge_graph", "fuse_knowledge_graphs"]
  - name: profile
    kind: object
    required: true
    aliases: ["learnerProfile"]
    hint: "学习者画像 { knownConceptIds?: string[]; goalConceptIds?: string[]; availableMinutes?: number }"
  - name: targetOccupation
    kind: string
    required: false
    hint: "目标岗位（产业图谱岗位实体 ID 或名称）：有值且提供 industryGraph 时，以该岗位 required skill 的缺口倒排学习优先级；缺省行为不变"
  - name: industryGraph
    kind: object
    required: false
    hint: "产业图谱（build_industry_graph 输出），targetOccupation 生效的前提"
    producer: ["build_industry_graph"]
```
## 输出
- `personalizedPath`：有序路径步骤 `[{ nodeId, title, kind: 'concept' | 'section', reason?, minutes }]`（reason 为 LLM 生成或模板理由："路径起点"/"课程章节主线"/"拓扑必需：是后续概念的先修"/"拓扑必需：目标前置"；分钟估算：章节 10、概念 5）
- `learningSequence`：推荐学习顺序（节点 ID 序列，序与拓扑排序一致，含先修校验）
- `coverage`：覆盖说明 `{ skippedKnown, goalsReached, truncatedByBudget, prunedByGoals }`

## 依赖
- 无硬性外部依赖（图谱来自上游技能）；`llm` 可选，仅用于增强 reason

## 降级策略
- 启发式默认实现即契约语义：按先修拓扑默认顺序（topoOrder）规划，叠加已知概念剪枝、目标先修闭包裁剪与分钟预算截断；无画像或画像数据不足时退化为全量拓扑序（等级保持 full——这是默认行为而非能力缺失）。
- LLM reason 生成失败时回落模板理由并标记 degraded。
- 图谱为空时仅返回空路径骨架并标记 degraded。

## 调用示例
```json
{
  "skillId": "recommend_learning_path",
  "inputs": {
    "knowledgeGraph": "$extract_knowledge_graph",
    "profile": { "knownConceptIds": ["con-a"], "goalConceptIds": ["con-d"], "availableMinutes": 120 }
  },
  "ctx": {
    "llm": "<宿主注入的 LLMProvider，可选>"
  }
}
```
