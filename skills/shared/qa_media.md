# 媒体验收（qa_media）

## 技能 ID
`qa_media`

## 中文名
媒体验收

## 类型
共享型（shared）

## 输入
- `mediaFile`（可选）：视频/音频文件路径（引擎检查必需；纯字幕检查可为空）
- `subtitles`（可选）：SRT 字幕文本（时间轴静态检查永远可用：回绕/重叠/静默间隔）
- `checks`（可选）：`{ keyframes?: boolean（场景切换）, silence?: boolean（静音段）, subtitles?: boolean }`，默认全开

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "视频/动画资产自动验收门禁：场景切换关键帧、静音占比、字幕时间轴回绕/重叠检测"
inputs:
  - name: mediaFile
    kind: string
    required: false
    hint: "视频/音频文件路径（引擎检查必需；纯字幕检查可省略）"
  - name: subtitles
    kind: string
    required: false
    hint: "SRT 字幕文本：时间轴静态检查（end<start 回绕、重叠区间、超长静默）永远可用"
  - name: checks
    kind: object
    required: false
    hint: "{ keyframes?, silence?, subtitles? } 子检查开关，默认全开"
```

## 输出
- `findings`：问题清单 `[{ type（subtitle_wrap|subtitle_overlap|subtitle_gap|subtitle_empty|no_keyframe|scene_threshold_fallback|silence_heavy|meta）, severity, message, atMs? }]`；`scene_threshold_fallback`（R11-2，low）：画面渐变时场景阈值自适应降级（0.3→0.15/0.05）复扫的注明，全阶梯为零则诚实报告"该素材无显著场景切换（或全程渐变）"，不伪造关键帧
- `video`：元数据 `{ durationMs, width, height, bitrateKbps, codec }`（引擎可用时）
- `keyframeTimestampsMs`：场景切换时间戳（引擎 + keyframes 检查开启时；R11-2 起阈值自适应：首轮 0.3 未命中按 0.15/0.05 复扫）
- `sceneScan`：`{ thresholdUsed, rescanned }`（R11-2：实际命中阈值与是否触发降级复扫）
- `silenceSegmentsMs`：静音段 `[startMs,endMs]`（silencedetect 解析）
- `cueCount`：字幕条数；`stats`：`{ high, medium, low }`
- `engine`：`ffmpeg` / `none`

## 依赖
- `ffmpeg/ffprobe`（引擎，PATH 探测）：缺失时字幕静态检查仍可用；引擎状态经 describe_capabilities 暴露（optional-not-installed + 安装指引）

## 降级策略
- 无引擎 + 无字幕 → unavailable + 安装指引（诚实，不编造检查结果）
- 无引擎 + 有字幕 → degraded：仅静态时间轴检查 + 安装指引
- 引擎调用失败（超时/异常）→ 该项跳过并在 findings 标注，不冒泡杀进程

## 调用示例
```json
{
  "skillId": "qa_media",
  "inputs": {
    "mediaFile": "D:/课程/标志重捕法动画/成品.mp4",
    "subtitles": "1\n00:00:00,000 --> 00:00:02,000\n种群密度是……"
  }
}
```
