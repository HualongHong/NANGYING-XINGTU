# 反馈协调（submit_feedback）

## 技能 ID
`submit_feedback`

## 中文名
反馈协调

## 类型
共享型（shared）

## 输入
- `stage`（可选）：`prepare`（默认）生成脱敏反馈草稿供审阅；`approve` 审阅通过后入库
- `kind`（prepare 必填）：`install_issue` | `usage_issue` | `praise`（满意执行）| `not_used`（未使用插件的场景）| `suggestion`
- `summary`（prepare 必填）：一句话标题
- `detail`（可选）：详细描述（现象/复现步骤/期望行为/堆栈）
- `context`（可选）：环境信息（平台/版本/系统/安装方式），将与正文一并脱敏
- `includeSensitive`（可选，默认 false）：**显式命令**保留敏感信息（调试用）
- `sensitiveExcerpt`（可选）：用户显式提供的敏感片段；仅 `includeSensitive=true` 时收录进「敏感附件」段，否则按默认脱敏策略忽略
- `draft`（approve 必填）：prepare 返回并经用户审阅的 draft 对象（原样或修订版）
- `approved`（approve 必填且必须为 `true`）：审阅通过声明；**不为 true 一律拒绝储存**
- `reviewComment`（可选）：审阅意见，随文档入库

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "两阶段反馈：stage=prepare 生成默认脱敏的反馈草稿（绝不入库）→ 用户审阅 → stage=approve 且 approved=true 才存储至 .nangying-feedback/，供 loop engineering 监控"
inputs:
  - name: stage
    kind: string
    required: false
    hint: '"prepare"（默认）生成脱敏草稿供审阅；"approve" 审阅通过后入库'
  - name: kind
    kind: string
    required: false
    hint: "prepare 必填：install_issue | usage_issue | praise | not_used | suggestion"
  - name: summary
    kind: string
    required: false
    hint: "prepare 必填：一句话标题（非空）"
  - name: detail
    kind: string
    required: false
    hint: "详细描述：现象/复现步骤/期望行为，可附堆栈"
  - name: context
    kind: string
    required: false
    hint: "环境信息：平台/版本/系统/安装方式（将与正文一并脱敏）"
  - name: includeSensitive
    kind: boolean
    required: false
    hint: "true=用户显式命令保留敏感信息（调试）；默认 false 全部脱敏"
  - name: sensitiveExcerpt
    kind: string
    required: false
    hint: "用户显式提供的敏感片段；仅 includeSensitive=true 时收录进「敏感附件」段"
  - name: draft
    kind: object
    required: false
    hint: "approve 必填：prepare 返回并经用户审阅的 draft 对象（原样或修订版）"
  - name: approved
    kind: boolean
    required: false
    hint: "approve 必填且必须为 true（用户审阅通过）；否则拒绝储存"
  - name: reviewComment
    kind: string
    required: false
    hint: "审阅意见（可选，随文档入库）"
```

## 输出
- prepare 返回 `draft`（脱敏后文档：docId/kind/kindLabel/summary/detail/context/redactions/sensitive?/reviewGate）+ `redactionSummary`；**不落盘**
- approve 返回 `stored` / `path` / `docId` + loop 提示；文档写入 `.nangying-feedback/accepted/<docId>.json` 并追加 `index.jsonl`

## 依赖
- 无（纯本地编排 + 文件写入；脱敏为确定性纯函数）

## 降级策略
无外部依赖，永远可用。输入非法返回 `INVALID_INPUT` 结构化错误（含缺失项与最小示例），任何阶段都不储存非法文档；`approve` 未经 `approved=true` 直接拒绝。

## 调用示例
```json
{
  "skillId": "submit_feedback",
  "inputs": {
    "stage": "prepare",
    "kind": "install_issue",
    "summary": "pnpm install 时 sharp 构建脚本被忽略",
    "detail": "运行 pnpm install 报 ERR_PNPM_IGNORED_BUILDS，平台 Ubuntu 24.04，插件版本 1.8.0",
    "context": "Node 22.14.0 / pnpm 12.18.0"
  }
}
```
审阅通过后：
```json
{
  "skillId": "submit_feedback",
  "inputs": { "stage": "approve", "approved": true, "draft": { "...": "prepare 返回的 draft" }, "reviewComment": "复现已确认" }
}
```
