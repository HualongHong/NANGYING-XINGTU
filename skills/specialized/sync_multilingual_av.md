# 多语种音视频同步（sync_multilingual_av）

## 技能 ID
`sync_multilingual_av`

## 中文名
多语种音视频同步

## 类型
特化型（specialized）

## 输入
- `tracks`：各语种字幕轨 `[{ lang, format: 'srt', content }]`（translate_multilingual / synthesize_speech 产物）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "把多语种音轨/字幕与画面对齐同步（引擎未接入时降级为分语种独立输出）"
inputs:
  - name: tracks
    kind: array
    required: true
    aliases: ["subtitleTracks", "audioTracks"]
    hint: "各语种字幕轨 [{ lang, format: "srt", content }]（translate_multilingual / synthesize_speech 产物）"
    producer: ["translate_multilingual"]
```
## 输出
分语种独立交付清单（降级形态）：
- `aligned`：`false`（不对齐）
- `deliverables`：`[{ lang, files: [{ kind: 'subtitle', name: 'course.<lang>.srt', content, timecode: 'independent' }] }]`——按语种分组，各自保留独立时码，不保证跨语种一致
- `note`：降级说明

## 依赖
- `avAlignment`：音视频对齐引擎（时码对齐、语速适配）

## 降级策略
对齐能力不可用时退化为分语种独立输出：每个语种单独输出交付文件，不保证跨语种时码一致。当前实现即此降级形态（level=degraded）；宿主注入对齐引擎后可升级为 full。

## 调用示例
```json
{
  "skillId": "sync_multilingual_av",
  "inputs": {
    "tracks": "$synthesize_speech.subtitleTracks"
  }
}
```
