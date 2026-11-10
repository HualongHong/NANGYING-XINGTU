# 能力自述（describe_capabilities）

## 技能 ID
`describe_capabilities`

## 中文名
能力自述

## 类型
共享型（shared）

## 输入
- `skillId`（可选）：只返回该技能的详情；缺省返回全部技能的入参契约

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "列出全部技能的真实入参名/别名/必填/类型/上游技能/降级条件，可按 skillId 过滤"
inputs:
  - name: skillId
    kind: string
    required: false
    hint: "只返回该技能的详情；缺省返回全部技能"
```

## 输出
- `skills`：技能契约数组，每项含：
  - `skillId` / `name` / `type` / `description` / `degradation`（降级策略）/ `usage`（一句话用法）
  - `inputs`：入参契约数组 `[{ name, kind, required, aliases, hint, producer }]`——`name` 为真实契约名，`aliases` 为兼容别名（自动归一化），`producer` 为上游技能（输出的生产者）
  - `required`：必填入参名列表
- `count`：返回的技能数

## 依赖
- 无（读注册表与契约声明，毫秒级返回）

## 降级策略
`skillId` 不存在时返回 `unavailable` 并列出全部可用技能 id；本技能无外部依赖，永远可用。

## 调用示例
```json
{
  "skillId": "describe_capabilities",
  "inputs": { "skillId": "manage_course_assets" }
}
```
