# 数字人授课视频生成（generate_digital_human_video）

## 技能 ID
`generate_digital_human_video`

## 中文名
数字人授课视频生成

## 类型
特化型（specialized）

## 输入
- `script`：教学脚本（generate_teaching_script 的 TeachingScript）
- `avatarId`：授课数字分身标识（来自 register_teacher_avatar，可选）
- `sceneConfig`：场景配置（可选，降级形态下不生效）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "基于讲稿与数字分身生成授课视频（引擎未接入时降级为 PPT 翻页配字幕）"
inputs:
  - name: script
    kind: object
    required: true
    aliases: ["voiceoverScript"]
    hint: "generate_teaching_script 的输出（TeachingScript）"
    producer: ["generate_teaching_script"]
  - name: avatarId
    kind: string
    required: false
    hint: "授课数字分身标识（register_teacher_avatar 产物）"
  - name: sceneConfig
    kind: object
    required: false
    hint: "场景配置（降级形态下不生效）"
```
## 输出
制作清单（降级形态，可交给外部工具执行）：
- `mode`：`'ppt-subtitle'`
- `slides`：每 scene 一页 `[{ sceneId, lessonId, phase, title, visual, voiceover, durationSeconds }]`
- `subtitleTrack`：SRT 时码字幕文本
- `renderParams`：`{ resolution: '1280x720', fps: 25, background, avatar }`

## 依赖
- `videoGeneration`：视频生成引擎
- `lipSync`：口型同步引擎

## 降级策略
视频生成或口型同步不可用时，退化为 PPT 翻页配字幕的讲解视频——当前实现产出该形态的制作清单（level=degraded），授课内容不受影响；宿主注入视频生成 provider 后可升级为 full。

## 调用示例
```json
{
  "skillId": "generate_digital_human_video",
  "inputs": {
    "script": "$generate_teaching_script",
    "avatarId": "$register_teacher_avatar.avatarId"
  }
}
```
