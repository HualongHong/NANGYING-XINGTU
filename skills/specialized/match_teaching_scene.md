# 多场景智能匹配切换（match_teaching_scene）

## 技能 ID
`match_teaching_scene`

## 中文名
多场景智能匹配切换

## 类型
特化型（specialized）

## 输入
- `script`：教学脚本（generate_teaching_script 的 TeachingScript，取其中全部 scene 作为教学环节序列）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "按教学脚本匹配虚拟教学场景（引擎未接入时降级为固定背景）"
inputs:
  - name: script
    kind: object
    required: true
    aliases: ["teachingSegments"]
    hint: "generate_teaching_script 的输出（取全部 scene 作为教学环节序列）"
    producer: ["generate_teaching_script"]
  - name: sceneLibrary
    kind: any
    required: false
    hint: "场景库（可选；引擎未接入时忽略）"
```
## 输出
- `mode`：`'fixed-background'`
- `background`：固定背景描述（浅绿板书墙 + 木质讲台的固定教室）
- `assignments`：`[{ sceneId, phase, background }]`——每环节配统一固定背景
- `transitions`：空数组（降级形态无场景切换；接入场景库后输出切换点与转场方式）

## 依赖
- `sceneLibrary`：场景素材库
- `videoComposition`：视频合成能力

## 降级策略
场景库或合成能力不可用时退化为固定背景：全部片段使用统一默认背景授课。当前实现即此降级形态（level=degraded）；宿主注入场景库后可升级为 full。

## 调用示例
```json
{
  "skillId": "match_teaching_scene",
  "inputs": {
    "script": "$generate_teaching_script"
  }
}
```
