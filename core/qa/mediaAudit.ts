/**
 * 媒体验收门禁（qa_media，技能 #26，R7-4）——core 纯函数部分。
 *
 * 反馈 a N2：视频/动画资产自动验收（关键帧、字幕对齐、节奏、回绕缺陷）。
 * 架构：引擎门控（ffmpeg/ffprobe 归适配层探测）：
 *  - 纯字幕静态检查（SRT 时间轴：end<start 回绕、重叠区间、超长间隔）永远可用；
 *  - 视频检查（时长/码率/分辨率、静音段占比、场景切换关键帧）需 ffmpeg 引擎。
 * 无引擎：有字幕 → degraded（静态检查 + 安装指引）；无字幕 → unavailable。
 * 纯 TS、零 Node API、确定性。
 */

export const QA_MEDIA_ID = 'qa_media';

export interface SubtitleCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export type MediaFindingType =
  | 'subtitle_wrap'      // end < start 回绕
  | 'subtitle_overlap'   // 与上一条重叠
  | 'subtitle_gap'       // 与上一条间隔过大（节奏）
  | 'subtitle_empty'     // 空字幕文本
  | 'no_keyframe'        // 场景切换过少（节奏/静态嫌疑）
  | 'scene_threshold_fallback' // R11-2：渐变画面场景阈值自适应降级复扫
  | 'silence_heavy'      // 静音段占比过高
  | 'meta';

/** R11-2：场景阈值自适应复扫信息（适配层传入） */
export interface SceneScanInfo {
  /** 实际命中阈值（0.3/0.15/0.05 之一） */
  thresholdUsed: number;
  /** 首轮 0.3 未命中，已按降级阈值复扫 */
  rescanned: boolean;
}

export interface MediaFinding {
  type: MediaFindingType;
  severity: 'high' | 'medium' | 'low';
  message: string;
  /** 涉及时间点（ms） */
  atMs?: number;
}

export interface MediaAuditInput {
  /** 视频/音频文件路径（适配层读取；纯字幕检查可为空） */
  mediaFile?: string;
  /** SRT 字幕文本（静态时间轴检查） */
  subtitles?: string;
  /** 开关子检查（默认全开） */
  checks?: {
    keyframes?: boolean;
    silence?: boolean;
    subtitles?: boolean;
  };
}

export interface VideoMeta {
  durationMs?: number;
  width?: number;
  height?: number;
  bitrateKbps?: number;
  codec?: string;
  sizeBytes?: number;
}

export interface MediaAuditReport {
  engine: 'ffmpeg' | 'none';
  findings: MediaFinding[];
  /** 视频元数据（引擎可用时） */
  video?: VideoMeta;
  /** 场景切换关键帧时间点（引擎可用且开启 keyframes 检查） */
  keyframeTimestampsMs?: number[];
  /** R11-2：场景阈值自适应复扫信息（rescanned=true 说明画面渐变/阈值降级） */
  sceneScan?: SceneScanInfo;
  /** 静音段 [startMs,endMs]（silencedetect 解析） */
  silenceSegmentsMs?: Array<[number, number]>;
  /** 字幕解析结果（静态检查用） */
  cueCount?: number;
  stats: {
    high: number;
    medium: number;
    low: number;
  };
}

/** SRT 解析（容错：空行分块、逗号/点号毫秒） */
export function parseSrt(srt: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = srt.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(lines[timeIdx]);
    if (!m) continue;
    const toMs = (h: string, mi: string, s: string, ms: string) =>
      ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + Number(ms.padEnd(3, '0'));
    cues.push({
      index: cues.length + 1,
      startMs: toMs(m[1], m[2], m[3], m[4]),
      endMs: toMs(m[5], m[6], m[7], m[8]),
      text: lines.slice(timeIdx + 1).join(' '),
    });
  }
  return cues;
}

/** 字幕时间轴静态检查（确定性，永远可用） */
export function auditSubtitleTimeline(
  cues: SubtitleCue[],
): MediaFinding[] {
  const findings: MediaFinding[] = [];
  let prev: SubtitleCue | null = null;
  for (const cue of cues) {
    if (cue.endMs < cue.startMs) {
      findings.push({
        type: 'subtitle_wrap',
        severity: 'high',
        atMs: cue.startMs,
        message: `第 ${cue.index} 条回绕：end(${cue.endMs}ms) < start(${cue.startMs}ms)`,
      });
    }
    if (cue.text.trim() === '') {
      findings.push({
        type: 'subtitle_empty',
        severity: 'medium',
        atMs: cue.startMs,
        message: `第 ${cue.index} 条字幕为空`,
      });
    }
    if (prev) {
      const overlap = prev.endMs - cue.startMs;
      if (overlap > 0) {
        findings.push({
          type: 'subtitle_overlap',
          severity: 'high',
          atMs: cue.startMs,
          message: `第 ${prev.index}-${cue.index} 条重叠 ${overlap}ms（时间轴冲突）`,
        });
      } else if (cue.startMs - prev.endMs > 5000 && prev.endMs > 0) {
        findings.push({
          type: 'subtitle_gap',
          severity: 'low',
          atMs: prev.endMs,
          message: `第 ${prev.index} 条后静默 ${cue.startMs - prev.endMs}ms（节奏断点，确认是否有意留白）`,
        });
      }
    }
    prev = cue.endMs >= cue.startMs ? cue : prev;
  }
  return findings;
}

/** 引擎侧结果合并（适配层传入 ffprobe/silence/scene 解析产物） */
export function mergeEngineFindings(
  base: MediaFinding[],
  video: VideoMeta | undefined,
  keyframes: number[] | undefined,
  silences: Array<[number, number]> | undefined,
  durationMs: number | undefined,
  sceneScan?: SceneScanInfo,
): MediaFinding[] {
  const findings = [...base];
  if (video && keyframes && durationMs && durationMs > 10_000) {
    const density = keyframes.length / (durationMs / 60_000);
    if (keyframes.length < 3 || density < 0.3) {
      findings.push({
        type: 'no_keyframe',
        severity: 'medium',
        message: `场景切换密度 ${density.toFixed(1)}/分钟（共 ${keyframes.length} 个）：疑似静态画面或镜头语言单一`,
      });
    }
  }
  // R11-2：阈值自适应复扫如实注明——渐变得手报告降级阈值，全零诚实报告不伪造
  if (sceneScan?.rescanned) {
    if (keyframes && keyframes.length > 0) {
      findings.push({
        type: 'scene_threshold_fallback',
        severity: 'low',
        message: `画面渐变：场景检测阈值自适应降级（0.3 → ${sceneScan.thresholdUsed}）复扫，检出 ${keyframes.length} 个切换点`,
      });
    } else {
      findings.push({
        type: 'scene_threshold_fallback',
        severity: 'low',
        message: '该素材未检出显著场景切换（或全程渐变）：阈值 0.3/0.15/0.05 复扫均为零，按诚实策略不伪造关键帧',
      });
    }
  }
  if (silences && durationMs && durationMs > 0) {
    const silentMs = silences.reduce((a, [s, e]) => a + Math.max(0, e - s), 0);
    const ratio = silentMs / durationMs;
    if (ratio > 0.3) {
      findings.push({
        type: 'silence_heavy',
        severity: 'medium',
        message: `静音占比 ${(ratio * 100).toFixed(0)}%（${(silentMs / 1000).toFixed(1)}s/${(durationMs / 1000).toFixed(1)}s）：检查旁白缺失或音量门限`,
      });
    }
  }
  return findings;
}

export function finalizeReport(report: Omit<MediaAuditReport, 'stats'>): MediaAuditReport {
  const stats = { high: 0, medium: 0, low: 0 };
  for (const f of report.findings) stats[f.severity] += 1;
  return { ...report, stats };
}
