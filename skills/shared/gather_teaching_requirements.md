# 教学需求治理（gather_teaching_requirements）

## 技能 ID
`gather_teaching_requirements`

## 中文名
教学需求治理

## 类型
共享型（shared）

## 输入
- `answers`（可选）：本轮 Q1–Q8 回答键值对象 `{ courseMeta, knowledgeStructure, abstractCollection, template, teachingParams, depthAndPlan, casePreferences, extraOutputs }`（值可以是字符串、对象或数组，空值视为未答）
- `priorAnswers`（可选）：上一轮同键值回答——迭代改版场景。未重答的项给 `carriedOver` 建议（须明确复述请用户确认），答了但不同的项给 `changed` 标注，防静默改口径
- `confirmedCarryOver`（可选）：用户明确确认沿用的 question id 数组（如 `["Q1","Q5"]`），确认过的沿用项不再要求复述
- `corrections`（可选）：用户纠偏记录数组 `[{ quote, content, layer?, artifacts?, regression?, effectiveVersion? }]`——每次「不是这样」登记一条（方法论 H8 纠偏即登记）：`quote`=用户原话摘录，`content`=**可判定的祈使句**（如「课堂前沿拓展只保留一页引入标签」，不是「简化案例」这种不可判定的描述）；`layer` 缺省 `auto`（按内容信号自动分层，拿不准归 P）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "科教融合备课工作流第一步：开工必问 Q1–Q8 校验与停工判定、H/P 约束分层与纠偏登记表、迭代场景沿用并复述"
inputs:
  - name: answers
    kind: object
    required: false
    hint: "本轮 Q1–Q8 回答键值 { courseMeta, knowledgeStructure, abstractCollection, template, teachingParams, depthAndPlan, casePreferences, extraOutputs }；空值视为未答"
  - name: priorAnswers
    kind: object
    required: false
    hint: "上一轮同键值回答（迭代场景）：未重答项给 carriedOver 建议，答了但不同项给 changed 标注"
  - name: confirmedCarryOver
    kind: array
    required: false
    hint: "用户明确确认沿用的 question id 数组（如 [\"Q1\",\"Q5\"]），确认后不再要求复述"
  - name: corrections
    kind: array
    required: false
    hint: "纠偏记录 [{ quote, content, layer?, artifacts?, regression?, effectiveVersion? }]，content 写可判定祈使句；layer 缺省 auto（拿不准归 P）"
```

## 输出
- `checklist`：8 项必问清单逐项状态 `{ id, key, question, contract, severity, status, answer?, carriedOver?, changed? }`——severity 三档：`blocking`（Q1–Q3 必需，缺则停工不编造）/`defaultable`（Q4 模板有默认但须复述确认）/`collect`（Q5–Q8 逐项问不预设）
- `stopWork`：任一必问项未答即 `true`——agent 必须停下来逐项问，不给默认值、不做「合理假设」
- `blockingMissing` / `toCollect`：缺答的停工项 id / 采集项 id
- `assumptionsUsed`：使用默认的项（仅 Q4 模板契约），开工时须明确复述
- `constraintRegistry`：约束登记表（方法论附录 B 字段：`id, version, quote, layer, content, artifacts, regression, effectiveVersion, status`）
- `replay`：纠偏回放清单——下一版开工逐条确认，防「长期口径当一次性补丁、旧内容复活」（方法论 1.4）

## 依赖
无（纯判定，零 IO、零 LLM）。

## Agent 执行协议（技能正文，提问不由本插件代劳）
1. **先规划后执行**：大改动先产规划（目标/约束/流水线/逐条验收/风险回滚），显式等确认。
2. **提问时机**：动手前一次性批量问（每轮 ≤4 问，超了分轮）；前提不成立时先给只读核查事实再问；会改变已验收结构的问题单独问并明确告知后果（如「总帧 86→87、节起页顺延」）。
3. **迭代场景**：Q1–Q3、Q5–Q8 可「沿用上一版并复述请确认」；被纠偏过的项必须重新确认。
4. **约束分层**：换一门课还成立的归 H（写进长期口径），可能变的归 P（每次开工重新确认）；纠偏登记后判断改渲染输出还是改内容源——**长期口径一律改内容源**，并逐产物列出同步位置。
5. **停工纪律**：stopWork=true 时不得进入 parse_abstract_collection。

## 降级策略
- 无 LLM、无外部依赖，任何环境下行为一致；输入非法返回结构化错误（哪一项、期望形态）。
- `corrections` 缺 `quote`/`content` 或 `layer` 非 H/P/auto 时拒绝该条并指明原因，其余条目照常处理。

## 调用示例
首轮开工：
```json
{
  "skillId": "gather_teaching_requirements",
  "inputs": {
    "answers": {
      "courseMeta": "土壤学 · 第 3 章 土壤质地与结构 · 王老师",
      "knowledgeStructure": { "sections": ["3.1 质地", "3.2 结构"], "keyPoints": ["团粒结构", "质地分类"] },
      "abstractCollection": "/data/土壤学会2026摘要集.pdf"
    },
    "corrections": [{ "quote": "这是独立的课程不是某课下的章节", "content": "封面与页眉不得出现其他课程名" }]
  }
}
```
迭代轮（沿用并复述）：
```json
{
  "skillId": "gather_teaching_requirements",
  "inputs": {
    "answers": { "casePreferences": "一篇摘要=一个案例，一页原文+一页解说" },
    "priorAnswers": { "courseMeta": "土壤学 · 第 3 章 土壤质地与结构 · 王老师" },
    "confirmedCarryOver": ["Q1"]
  }
}
```
