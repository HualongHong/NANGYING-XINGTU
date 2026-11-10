# 双语同步（sync_bilingual）

## 技能 ID
`sync_bilingual`

## 中文名
双语同步

## 类型
共享型（shared）

## 输入
- `primaryText`：中文主文档（mirror 模式逐字不动——"中文零改动"）
- `secondaryLang`：目标语种（en/ru/fr/ko…）
- `lockedSegments`（可选）：术语/公式锁定清单，命中即锁（LLM 不得改动；一致性检查以此为基准）
- `mode`（可选）：`'mirror'`（默认，逐段对齐译文+锚点表）| `'translate'`（复用 translate_multilingual 的 glossary 机制）
- `glossary`（可选）：术语库（translate 模式与一致性检查基准）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "中英双语同步：中文零改动为锚，逐段对齐译文 + 术语锁定一致性检查"
inputs:
  - name: primaryText
    kind: string
    required: true
    hint: "中文主文档（mirror 模式逐字不动）"
  - name: secondaryLang
    kind: string
    required: true
    hint: "目标语种（en/ru/fr/ko…）"
  - name: lockedSegments
    kind: array
    required: false
    hint: "术语/公式锁定清单：命中即锁（LLM 不得改动；一致性检查以此为基准）"
  - name: mode
    kind: string
    required: false
    hint: "'mirror'（默认：逐段对齐译文+锚点表）|'translate'（复用 translate_multilingual glossary 机制）"
  - name: glossary
    kind: any
    required: false
    hint: "术语库对象（translate 模式与一致性检查基准）"
```

## 输出
- `segments`：逐段对照 `[{ index, primary（中文原文）, secondary（译文；null=未译骨架） }]`
- `anchors`：段落锚点对应表（primary ↔ secondary 一一对应）
- `termConsistency`：术语一致性 `[{ term, expected（规范译名）, segmentIndexes（出现段）, missing（规范译名缺失段） }]`
- `translated`：translate 模式的同构译文产物
- `level`：full / degraded（无 LLM：仅段落切分+对照骨架；LLM 失败：回落骨架——诚实不编造译文）

## 依赖
- mirror 模式的逐段对齐译文需注入 `llm`；translate 模式复用 translate_multilingual（同样以 LLM 为佳，降级语义一致）

## 降级策略
- 缺 primaryText/secondaryLang → unavailable + INVALID_INPUT
- 无 LLM → degraded：段落切分 + 对照骨架（中文零改动），不产出译文
- LLM 失败/段数不匹配 → degraded：回落对照骨架

## 调用示例
```json
{
  "skillId": "sync_bilingual",
  "inputs": {
    "primaryText": "# 种群生态学\n\n种群密度是种群最基本的数量特征。\n\n标志重捕法适用于活动能力强的动物。",
    "secondaryLang": "en",
    "mode": "mirror",
    "lockedSegments": ["种群密度", "标志重捕法"]
  }
}
```
