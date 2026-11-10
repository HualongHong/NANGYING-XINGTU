# 多教师数字分身协同（orchestrate_multi_teacher）

## 技能 ID
`orchestrate_multi_teacher`

## 中文名
多教师数字分身协同

## 类型
特化型（specialized）

## 输入
- `teachers`：教师列表 `[{ name, role? }]`（第一位为主讲）
- `lessonSegments`：授课片段 `[{ segmentId, title, minutes }]`

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "调度多个教师数字分身协同授课（引擎未接入时降级为单教师模式）"
inputs:
  - name: teachers
    kind: array
    required: true
    hint: "教师列表 [{ name, role? }]（第一位为主讲）"
  - name: lessonSegments
    kind: array
    required: true
    aliases: ["courseStructure"]
    hint: "授课片段 [{ segmentId, title, minutes }]"
```
## 输出
单教师执行计划（降级形态）：
- `mode`：`'single-teacher'`
- `primaryTeacher`：主讲教师（teachers 第一位）
- `assignments`：`[{ segmentId, title, teacher, minutes }]`——全部片段由主讲独立完成
- `note`：降级说明（原计划教师数与降级原因）

## 依赖
- `multiAvatarOrchestration`：多分身调度引擎

## 降级策略
多分身调度不可用时退化为单教师模式：由主讲分身独立完成全部授课内容。当前实现即此降级形态（level=degraded）；宿主接入多分身调度后可升级为 full。

## 调用示例
```json
{
  "skillId": "orchestrate_multi_teacher",
  "inputs": {
    "teachers": [{ "name": "王老师", "role": "主讲" }, { "name": "李老师", "role": "答疑" }],
    "lessonSegments": [{ "segmentId": "seg-1", "title": "导入", "minutes": 5 }]
  }
}
```
