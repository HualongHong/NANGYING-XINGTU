# 课程资产管理（manage_course_assets）

## 技能 ID
`manage_course_assets`

## 中文名
课程资产管理

## 类型
共享型（shared）

## 输入
- `operation`：资产操作指令（结构化形态，契约中 assetOperations 的明确形式）：
  - `{ op: 'register', asset }`：登记/新版本（同 id 再登记 version 递增）
  - `{ op: 'update', id, patch }`：更新（产生新版本；patch 不可改 id/version）
  - `{ op: 'checkout', id, version }`：检出历史版本
  - `{ op: 'remove', id }`：删除（被其他资产引用时报错，拒绝悬空引用）
  - `{ op: 'tagDependency', id, dependencyId }`：追加依赖引用
  - `{ op: 'list' }`：查询当前登记簿
- `store` / `storeJson` / `storePath`（三选一）：内存登记簿对象 / 序列化 JSON 字符串 / 本地 JSON 文件路径（经适配层 fs 存取，`adapters/core/assetStore.ts`）

资产元数据：`{ id, type: 'material'|'graph'|'script'|'package'|'video'|'subtitle'|'other', title, lang?, version（登记簿管理）, createdAt?（由调用方传入，core 不取系统时间）, dependencies: string[], checksum?, license?, note? }`

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "登记/更新/检出/删除课程资产并管理依赖；默认落盘本机登记簿，跨调用不丢"
inputs:
  - name: operation
    kind: object
    required: true
    aliases: ["assetOperations"]
    hint: "资产操作指令 { op: 'register'|'update'|'checkout'|'remove'|'tagDependency'|'list'|'export', ... }；别名 assetOperations 兼容数组形态（单元素自动解包，多元素顺序执行）"
  - name: store
    kind: any
    required: false
    hint: "内存登记簿对象（与 storeJson/storePath 三选一，优先级最高）"
  - name: storeJson
    kind: string
    required: false
    hint: "序列化的登记簿 JSON 字符串"
  - name: storePath
    kind: string
    required: false
    hint: "登记簿文件路径；未给任何存储参数时默认持久化到 ~/.nangying-starmap/assets.json"
```
## 输出
- `assetRegistry`：资产登记簿（各资产当前版本清单，按 id 排序）
- `versionHistory`：版本历史（含全部历史版本，按 id、version 排序）
- `metadataRecords`：元数据记录（全部历史版本的元数据）
- `store`：操作后的完整登记簿（供后续操作或序列化落盘）；`result`：checkout 检出的历史版本

## 依赖
- 无硬性外部依赖

## 降级策略
无外部存储/权限系统时退化为本地文件系统登记——实现即此语义：core 为纯内存模型（零 Node API），落盘由适配层 `assetStore.ts` 以 JSON 单文件管理（原子写入），与契约一致，等级保持 full。操作非法（悬空依赖/删除被引用资产/检出不存在版本）返回 `unavailable` 并附中文说明。

## 调用示例
```json
{
  "skillId": "manage_course_assets",
  "inputs": {
    "operation": { "op": "register", "asset": { "id": "graph-01", "type": "graph", "title": "课程图谱", "dependencies": [], "license": "CC-BY" } },
    "storePath": "assets/registry.json"
  }
}
```
