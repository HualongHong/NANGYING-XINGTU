# 知识图谱比对（diff_knowledge_graphs）

## 技能 ID
`diff_knowledge_graphs`

## 中文名
知识图谱比对

## 类型
共享型（shared）

## 输入
- `graphA`、`graphB`：两份课程知识图谱（extract_knowledge_graph 的星图中枢 schema）
- `labelA`、`labelB`（可选）：来源标签，如"课件 v1"/"讲义"
- `ctx`（可选）：宿主注入上下文，可携带 `llm` 生成语义重命名候选

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "比对两份知识图谱的实体/边差集与相似度，支持版本前后对比"
inputs:
  - name: graphA
    kind: object
    required: true
    hint: "星图中枢 schema 图谱对象（extract/fuse 输出；JSON 字符串自动解析）"
    producer: ["extract_knowledge_graph", "fuse_knowledge_graphs"]
  - name: graphB
    kind: object
    required: true
    hint: "星图中枢 schema 图谱对象（extract/fuse 输出；JSON 字符串自动解析）"
    producer: ["extract_knowledge_graph", "fuse_knowledge_graphs"]
  - name: labelA
    kind: string
    required: false
    hint: "来源标签，如「课件 v1」"
  - name: labelB
    kind: string
    required: false
    hint: "来源标签，如「讲义」"
```
## 输出
- `entitiesAdded` / `entitiesRemoved`：B 相对 A 的实体差集（按标签归一化索引；实体 ID 为内容哈希，跨文档同标签实体 ID 天然相同）
- `edgesAdded` / `edgesRemoved` / `edgesChanged`：边差集（按 from|to|type 键），weight 变化带 `weightBefore/weightAfter/delta`
- `similarity`：`{ entities, edges, sectionTitles }`——实体 Jaccard、边 Jaccard、章节标题重合率
- `renamedCandidates`：语义重命名候选对 `[{ a, b, reason }]`（LLM 注入时产出；失败为空并标 degraded）

## 依赖
- 无硬性外部依赖；`llm` 可选（仅用于 renamedCandidates）

## 降级策略
LLM 重命名候选生成失败时 `renamedCandidates` 为空并标记 degraded；其余差集与相似度为纯函数计算，恒可用。两图谱均为空时相似度记 1。

## 调用示例
```json
{
  "skillId": "diff_knowledge_graphs",
  "inputs": {
    "graphA": "$snapshot.v1",
    "graphB": "$extract_knowledge_graph",
    "labelA": "课件 v1",
    "labelB": "课件 v2"
  },
  "ctx": { "llm": "<宿主注入的 LLMProvider，可选>" }
}
```
