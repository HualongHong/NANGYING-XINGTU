# 教学数据集探查（inspect_teaching_dataset）

## 技能 ID
`inspect_teaching_dataset`

## 中文名
教学数据集探查

## 类型
共享型（shared）

## 输入
- `repo`（必填）：OpenDataLab 数据集仓库地址 `username/repo_name`（如 `OpenDataLab/UniTE`）
- `listFiles`（可选，默认 `true`）：是否拉取文件清单（`false` 时只回元信息，更快）
- `maxFiles`（可选，默认 200，上限 1000）：文件清单截断阈值
- `prefix`（可选）：只列出该子目录（如 `data/exams`），防 `..`

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "OpenDataLab 数据集仓库探查：元信息 + 文件清单 + 教学相关性启发式评分。公共仓库匿名即可探查（零配置）；受限仓库需配置 odlabAccessKeyId/odlabSecretAccessKey 命名密钥；平台不可用/仓库不存在返回结构化错误——不影响课程生产主流程"
inputs:
  - name: repo
    kind: string
    required: true
    hint: '数据集仓库地址 "username/repo_name"，如 OpenDataLab/UniTE'
  - name: listFiles
    kind: boolean
    required: false
    hint: "是否拉取文件清单（默认 true；false 只回元信息更快）"
  - name: maxFiles
    kind: number
    required: false
    hint: "文件清单截断阈值，1-1000 整数，默认 200"
  - name: prefix
    kind: string
    required: false
    hint: '只列该子目录（如 data/exams），防 ".."'
```

## 输出
- `level: 'full'`：`repo/name/owner/description/visibility/tags/fileCount/totalBytes/files[{path,size,isDir}]/teachingRelevance(high|medium|low)/matchedKeywords/truncated/source`；教学相关性按文件路径命中试题/教材/课件/课程等关键词启发式评分（确定性）
- `level: 'degraded'`：元信息拿到但文件清单被限流/截断时，清单部分为空并注明原因

## 依赖
- 可选：OpenDataLab 平台（OpenXLab OpenAPI，端点复刻自官方 openxlab SDK）；AK/SK 经 settings_card 数据集区块或 `OPENXLAB_AK`/`OPENXLAB_SK` 配置

## 平台政策
- **公共仓库匿名可探查**（官方 SDK 行为：info/list 对公开仓库无需授权）——无 AK/SK 零配置可用
- AK/SK 只用于 getJwt 的 HMAC 挑战签名（nonce→HMAC-SK→base64），明文不进 URL/日志/反馈
- 受限仓库 401/403 → 结构化提示配置 `odlabAccessKeyId`/`odlabSecretAccessKey` 命名密钥（0600）
- 端点可经 settings `extra.odlabEndpoint` 覆盖（官方演进兜底）；关键词检索端点为预留扩展位（官方 SDK 未暴露免费搜索 HTTP 端点）

## 降级策略
本技能为可选增强，**不影响课程生产主流程**：仓库不存在/网络失败 → 结构化错误（含下一步引导）；受限仓库无密钥 → 同上并附配置路径；元信息可得而清单失败 → degraded 半量返回。启发式评分纯本地确定性，不依赖平台。

## 调用示例
```json
{
  "skillId": "inspect_teaching_dataset",
  "inputs": { "repo": "OpenDataLab/UniTE", "maxFiles": 100 }
}
```
只回元信息：
```json
{
  "skillId": "inspect_teaching_dataset",
  "inputs": { "repo": "OpenDataLab/UniTE", "listFiles": false }
}
```
