# 教师工作台（teacher_workbench）

## 技能 ID
`teacher_workbench`

## 中文名
教师工作台

## 类型
共享型（shared）

## 输入
- `days`（可选，number）：执行轨迹统计窗口（天），默认 30
- `format`（可选，string）：`json`（默认，只返回报告对象）| `html`（同时渲染单文件仪表盘并落盘）
- `outputPath`（可选，string）：HTML 仪表盘写出路径；缺省 `<configDir>/workbench.html`；显式路径过写出安全护栏

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "聚合引擎状态/配置(脱敏)/异步作业/执行轨迹统计/知识库/反馈闭环为一份总体报告，可渲染单文件 HTML 仪表盘监测整体情况"
inputs:
  - name: days
    kind: number
    required: false
    hint: "执行轨迹统计窗口（天），默认 30；如 7"
  - name: format
    kind: string
    required: false
    hint: '"json"（默认）|"html"（渲染单文件仪表盘并落盘）'
  - name: outputPath
    kind: string
    required: false
    hint: "HTML 写出路径（仅 format=html 生效）；缺省 <configDir>/workbench.html；如 D:/reports/workbench.html"
```

## 输出
- `report`：工作台报告对象
  - `version` / `host`（OS/架构/Node 版本）/ `generatedAt`
  - `engines`：OCR、ffmpeg 等引擎探测状态（builtin / optional-not-installed / not-provided + 安装指引）
  - `settings`：provider/model/endpoint、已配置密钥名列表（**只报名字不报值**）、LLM/向量通道来源
  - `jobs`：异步作业运行中数量 + 最近 10 条摘要
  - `traces`：窗口内总调用/成功率/技能分布（次数/平均/P95 耗时）/最近错误（已脱敏）
  - `knowledgeBases`：各知识库概念数/证据数/体积/更新时间
  - `feedback`：已入库反馈总数/未消化数/类型分布
- `writtenHtml`（format=html 时）：仪表盘文件绝对路径（单文件零依赖，浏览器直接打开）

## 依赖
- 无外部服务依赖（全部本地数据源只读聚合；引擎探测为本地探测）

## 降级策略
永远可用。个别数据源缺失（无轨迹/无知识库/无反馈）时对应区块返回空集合并照常出报告；
HTML 写出路径命中安全护栏（配置目录/系统目录/凭证目录）时返回 `INVALID_INPUT` 结构化错误。

## 调用示例
```json
{
  "skillId": "teacher_workbench",
  "inputs": { "days": 7, "format": "html" }
}
```
