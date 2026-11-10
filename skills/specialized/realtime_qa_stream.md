# 实时问答流式交互（realtime_qa_stream）

## 技能 ID
`realtime_qa_stream`

## 中文名
实时问答流式交互

## 类型
特化型（specialized）

## 输入
- `question`：学习者提问文本
- `qaKnowledgeBase`：课程问答库（build_qa_knowledge_base 输出）
- `topK`：返回答案数（可选，默认 3）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "课堂实时问答（引擎未接入时降级为异步问答）"
inputs:
  - name: question
    kind: string
    required: true
    aliases: ["learnerQuestion"]
    hint: "学习者提问文本"
  - name: qaKnowledgeBase
    kind: object
    required: true
    hint: "build_qa_knowledge_base 的输出"
    producer: ["build_qa_knowledge_base"]
  - name: topK
    kind: number
    required: false
    hint: "返回答案数（默认 3）"
```
## 输出
- `mode`：`'async-single-turn'`（异步单轮；流式/打断语义降级说明）
- `question`：回显问题
- `answers`：`[{ qaId, question, answer, score, conceptIds }]`——复用问答库倒排检索的 topK 结果，score 为倒排命中得分（查询词未命中时以排名倒序给确定性分值），按置信度降序
- `note`：降级说明（无增量输出与打断控制）

## 依赖
- `realtimeChannel`：实时通信通道（WebSocket 等）
- `streamingApi`：流式生成 API

## 降级策略
实时通道不可用时退化为异步问答：问题经倒排检索直接返回答案列表，无流式输出。当前实现即此降级形态（level=degraded）；宿主注入实时通道后可升级为 full。

## 调用示例
```json
{
  "skillId": "realtime_qa_stream",
  "inputs": {
    "question": "什么是梯度下降？",
    "qaKnowledgeBase": "$build_qa_knowledge_base",
    "topK": 3
  }
}
```
