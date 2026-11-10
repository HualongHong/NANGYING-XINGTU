# 异步任务管理（manage_async_tasks）

## 技能 ID
`manage_async_tasks`

## 中文名
异步任务管理

## 类型
共享型（shared）

## 输入
- `operation`：操作类型 `'query' | 'list' | 'cancel' | 'cleanup'`（`gc` 同 `cleanup`）
- `jobId`：作业标识（query/cancel 必填）
- `olderThanHours`（可选，cleanup 用）：终态作业保留小时数，默认 24
- `courseHint`（可选）：备注性过滤（当前仅透传记录）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "异步作业注册表：query/list/cancel/cleanup 作业状态、进度、结果与错误；cleanup 清理超龄终态作业"
inputs:
  - name: operation
    kind: string
    required: true
    hint: "操作类型 'query'|'list'|'cancel'"
  - name: jobId
    kind: string
    required: false
    hint: "作业标识（query/cancel 时必填）"
  - name: courseHint
    kind: string
    required: false
    hint: "备注性过滤（当前仅透传记录）"
  - name: olderThanHours
    kind: number
    required: false
    hint: "cleanup/gc 操作的清理阈值：终态（done/error/cancelled/interrupted）作业保留小时数，默认 24"
```
## 输出
- `job`（query/cancel）：作业快照 `{ jobId, skill, status: running/done/error/cancelled/interrupted, progress: {done,total,message}, result, error, elapsedMs, submittedAt }`
- `jobs`（list）：全部作业摘要（新的在前）
- 说明：server 重启后 running 作业标记 `interrupted`（提示重新提交）；完成结果保留 24 小时

## 依赖
- 无（本身毫秒级返回，就是作业注册表的查询封装）

## 降级策略
作业不存在返回 `unavailable` 并附中文说明；`cancel` 对非运行态作业幂等返回当前快照。无 LLM 依赖，永远可用。

## 调用示例
```json
{
  "skillId": "manage_async_tasks",
  "inputs": { "operation": "query", "jobId": "job-a1b2c3d4" }
}
```

## 配套：异步提交（async: true）
`parse_course_material` / `extract_knowledge_graph` / `fuse_knowledge_graphs` / `translate_multilingual` 四技能支持 `async: true`：立即返回 jobId，后台执行（LLM 阶段无 12 分钟同步预算，单请求 2 分钟超时降级仍生效），进度写入作业快照并发 progress 通知。轮询节奏建议：前 2 分钟 15 秒间隔，之后 60 秒间隔。
