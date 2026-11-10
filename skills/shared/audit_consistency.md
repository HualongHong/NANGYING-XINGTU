# 一致性核查（audit_consistency）

## 技能 ID
`audit_consistency`

## 中文名
一致性核查

## 类型
共享型（shared）

## 输入
- `assets`：课程资产数组（≥2 项）`[{ id, title?, text? | path? }]`——
  - `text`：材料纯文本；或 `path`：本地文件路径（由适配层读取，与 text 二选一）
  - 常见组合：教学大纲 / 教学日历 / 进度表 / 考核方案 / 讲义

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "跨材料一致性核查：日期/学时/数值口径/覆盖矛盾交叉比对，输出冲突清单（含涉及资产与建议）"
inputs:
  - name: assets
    kind: array
    required: true
    hint: "≥2 项 [{ id, title?, text? | path? }]：课程材料纯文本或本地文件路径（适配层读取）"
```

## 输出
- `conflicts`：冲突清单，每项 `{ type（date 日期|hours 学时|number 数值口径|coverage 覆盖矛盾）, severity（high|medium|low）, assets（涉及资产 id）, description（含具体取值）, suggestion（修改建议） }`
- `checkedAssets`：核查资产数
- `stats`：`{ byType }`

## 依赖
- 无强制外部依赖；注入 `llm` 时做语义级兜底复核（启发式未发现时补充前后矛盾等；失败保留启发式结果并标 degraded）

## 降级策略
- assets 少于 2 项或形态非法 → unavailable + INVALID_INPUT + 最小示例
- LLM 复核失败 → 保留启发式结果并标 degraded（启发式永不被拖垮）
- 无冲突 → full + 空清单（诚实返回，不编造）

## 调用示例
```json
{
  "skillId": "audit_consistency",
  "inputs": {
    "assets": [
      { "id": "大纲", "title": "教学大纲", "text": "总学时：96。期末考试：2026-12-28。" },
      { "id": "日历", "title": "教学日历", "path": "D:/课程/教学日历.md" }
    ]
  }
}
```
