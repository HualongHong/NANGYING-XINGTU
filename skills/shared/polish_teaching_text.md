# 文本润色（polish_teaching_text）

## 技能 ID
`polish_teaching_text`

## 中文名
文本润色

## 类型
共享型（shared）

## 输入
- `text`：待润色教学文本（非空字符串）
- `styleHints`（可选）：`{ clichePatterns?: string[]（追加套话正则）, tone?: string（风格提示，进 LLM 提示词） }`
- `preserveTerms`（可选）：术语保护清单，LLM 改写不得增删改、不得换序
- `maxChangeRatio`（可选）：LLM 改动幅度上限（字符占比 0-1，默认 0.3）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "教学文本去机器味润色：套话清除/重复词/句长均衡/连接词多样性，注入 LLM 得逐句改写建议"
inputs:
  - name: text
    kind: string
    required: true
    hint: "待润色教学文本（非空字符串）"
  - name: styleHints
    kind: object
    required: false
    hint: "{ clichePatterns?: string[]（追加套话正则）, tone?: string（风格提示） }"
  - name: preserveTerms
    kind: array
    required: false
    hint: "术语保护清单：LLM 改写不得增删改、不得换序"
  - name: maxChangeRatio
    kind: number
    required: false
    hint: "LLM 改动幅度上限（字符占比 0-1，默认 0.3）"
```

## 输出
- `polished`：润色后文本（启发式套话清除 + LLM 建议合并应用）
- `changes`：改动清单 `[{ original, suggested, reason, type（cliche 套话|repetition 重复词|sentence_rhythm 句长|connective 连接词|llm） }]`；报告类改动（重复词/句长/连接词）不自动应用，供作者决策
- `stats`：`{ clicheRemoved, repetitionFlagged, avgSentenceLength, longSentenceCount, connectiveVariety, llmApplied, llmRejected, changeRatio }`
- `level`：full（LLM 完成）/ degraded（仅启发式报告，无 LLM 或 LLM 失败——诚实标注，不假装完成润色）

## 依赖
- 无强制外部依赖；注入 `llm` 时产出逐句改写建议（diff 形态）

## 降级策略
- text 为空 → unavailable + INVALID_INPUT
- 无 LLM → degraded：启发式层永远可用（套话清除直接改，其余进报告）
- LLM 失败 → degraded：回落启发式报告

## 调用示例
```json
{
  "skillId": "polish_teaching_text",
  "inputs": {
    "text": "综上所述，接下来我们来看种群密度的定义。种群密度是种群最基本的数量特征……",
    "preserveTerms": ["种群密度", "标志重捕法"],
    "maxChangeRatio": 0.25
  }
}
```
