# 多语种语音合成（synthesize_speech）

## 技能 ID
`synthesize_speech`

## 中文名
多语种语音合成

## 类型
特化型（specialized）

## 输入
- `script`：教学脚本（generate_teaching_script 的 TeachingScript；多语版本取 translate_multilingual 产物的同构结构）
- `lang`：目标语种标识（可选，默认 zh）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "把教学脚本合成多语种语音（引擎未接入时降级为纯字幕输出）"
inputs:
  - name: script
    kind: object
    required: true
    aliases: ["multilingualTexts"]
    hint: "generate_teaching_script 的 TeachingScript（多语版取 translate_multilingual 同构产物）"
    producer: ["generate_teaching_script"]
  - name: lang
    kind: string
    required: false
    hint: "目标语种标识（默认 zh）"
```
## 输出
- `subtitleTracks`：`[{ lang, format: 'srt', content }]`——由字幕轨渲染的 SRT 文本（cue 的 startMinute/minutes → `HH:MM:SS,mmm` 时码，纯函数、确定性）
- `audioTracks`：空数组（无 TTS 引擎，不产出音轨）

## 依赖
- `ttsEngine`：多语种 TTS 引擎

## 降级策略
TTS 不可用时退化为纯字幕输出：课程以字幕形态交付，不生成任何音轨。当前实现即此降级形态（level=degraded）；宿主注入 TTS provider 后可升级为 full。

## 调用示例
```json
{
  "skillId": "synthesize_speech",
  "inputs": {
    "script": "$generate_teaching_script",
    "lang": "zh"
  }
}
```
