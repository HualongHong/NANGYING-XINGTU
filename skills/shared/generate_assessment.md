# 图谱命题（generate_assessment）

## 技能 ID
`generate_assessment`

## 中文名
图谱命题

## 类型
共享型（shared）

## 输入
- `graph`：课程知识图谱（extract_knowledge_graph / fuse_knowledge_graphs 输出；实体 source/confidence 用于取材与核验）
- `count`（可选）：题数（默认 10，上限 50）
- `difficulty`（可选）：`'mixed'`（默认，easy/medium/hard 轮转）| `'easy'` | `'medium'` | `'hard'`
- `bloomLevels`（可选）：Bloom 层级约束数组（记忆/理解/应用/分析），默认全部允许
- `includeExplanations`（可选）：输出解析
- `commonErrors`（可选）：输出典型错误清单（错误归因直接决定教学价值，反馈 a 4.2-N1）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "从知识图谱自动出题：题干/题型/难度/Bloom/答案/解析/典型错误/评分点，概念与出处取材"
inputs:
  - name: graph
    kind: object
    required: true
    hint: "extract/fuse 的输出（含 entities 数组；实体 source/confidence 取材）"
    producer: ["extract_knowledge_graph", "fuse_knowledge_graphs"]
  - name: count
    kind: number
    required: false
    hint: "题数（默认 10，上限 50）"
  - name: difficulty
    kind: string
    required: false
    hint: "'mixed'（默认，三档轮转）|'easy'|'medium'|'hard'"
  - name: bloomLevels
    kind: array
    required: false
    hint: "Bloom 层级约束 ['记忆','理解','应用','分析']，默认全部允许"
  - name: includeExplanations
    kind: boolean
    required: false
    hint: "true 时输出解析"
  - name: commonErrors
    kind: boolean
    required: false
    hint: "true 时输出典型错误清单"
```

## 输出
- `assessment`：题册数组，每题 `{ id, stem（题干）, type（概念解释|辨析|应用）, difficulty, bloom, conceptIds（取材概念，星图可追溯）, answer（参考答案要点）, explanation?, commonErrors?, scoringPoints（评分点） }`
- `stats`：`{ count, byDifficulty, byBloom }`

## 依赖
- 无强制外部依赖；注入 `llm`（`LLMProvider`）时精炼题干/答案/解析（失败回落模板题并标 degraded）

## 降级策略
- 图谱为空 → degraded + 空题册
- LLM 精炼失败 → 回落启发式模板题并标 degraded（题册结构不变，永不出错形态）
- 图谱形态非法 → unavailable + INVALID_INPUT + 最小示例

## 调用示例
```json
{
  "skillId": "generate_assessment",
  "inputs": {
    "graph": "<extract_knowledge_graph 输出>",
    "count": 5,
    "difficulty": "mixed",
    "includeExplanations": true,
    "commonErrors": true
  }
}
```
