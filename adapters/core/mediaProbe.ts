/**
 * ffmpeg/ffprobe 探测与解析（qa_media 适配层，Node API）。
 *
 * 引擎门控：PATH 探测 ffprobe；不可用返回 null，由执行器走诚实降级
 * （engineStatus 三分机制同步把 ffmpeg 纳入 describe_capabilities 探测）。
 * 所有调用带超时（60s）与 try/catch——引擎异常绝不冒泡杀进程。
 */
import { execFile } from 'node:child_process';

const TIMEOUT_MS = 60_000;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout + stderr);
    });
  });
}

let ffmpegProbe: Promise<boolean> | null = null;

/** ffprobe 可用性（进程内缓存） */
export function probeFfmpegAvailable(): Promise<boolean> {
  ffmpegProbe ??= (async () => {
    try {
      await run('ffprobe', ['-version']);
      return true;
    } catch {
      return false;
    }
  })();
  return ffmpegProbe;
}

export interface FfprobeMeta {
  durationMs?: number;
  width?: number;
  height?: number;
  bitrateKbps?: number;
  codec?: string;
}

/** ffprobe 元数据（JSON 输出解析） */
export async function ffprobeMeta(filePath: string): Promise<FfprobeMeta | null> {
  try {
    const out = await run('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath,
    ]);
    const parsed = JSON.parse(out) as {
      format?: { duration?: string; bit_rate?: string };
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
    };
    const video = parsed.streams?.find((s) => s.codec_type === 'video');
    return {
      durationMs: parsed.format?.duration ? Math.round(Number(parsed.format.duration) * 1000) : undefined,
      width: video?.width,
      height: video?.height,
      bitrateKbps: parsed.format?.bit_rate ? Math.round(Number(parsed.format.bit_rate) / 1000) : undefined,
      codec: video?.codec_name,
    };
  } catch {
    return null;
  }
}

/** 静音段检测（silencedetect 解析） */
export async function detectSilence(filePath: string): Promise<Array<[number, number]> | null> {
  try {
    const out = await run('ffmpeg', [
      '-i', filePath, '-af', 'silencedetect=n=-30dB:d=2', '-f', 'null', '-',
    ]);
    const segments: Array<[number, number]> = [];
    let start: number | null = null;
    for (const m of out.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
      if (m[1] === 'start') start = Number(m[2]);
      else if (start !== null) {
        segments.push([Math.round(start * 1000), Math.round(Number(m[2]) * 1000)]);
        start = null;
      }
    }
    return segments;
  } catch {
    return null;
  }
}

/** 场景检测阈值阶梯（R11-2：渐变画面自适应复扫） */
export const SCENE_THRESHOLD_LADDER = [0.3, 0.15, 0.05];

export interface SceneScanResult {
  timestampsMs: number[];
  /** 实际命中阈值（阶梯之一） */
  thresholdUsed: number;
  /** 首轮 0.3 未命中后触发了降级阈值复扫 */
  rescanned: boolean;
}

/**
 * 场景切换关键帧时间戳（select gt(scene,TH) + showinfo 解析）。
 * R11-2 阈值自适应：首轮 0.3 检不到时按 0.15/0.05 复扫并注明降级；
 * 全阶梯为零 → 返回空数组 + rescanned=true（诚实报告，不伪造）。
 */
export async function sceneKeyframes(filePath: string): Promise<SceneScanResult | null> {
  try {
    let rescanned = false;
    for (const th of SCENE_THRESHOLD_LADDER) {
      const out = await run('ffmpeg', [
        '-i', filePath, '-vf', `select='gt(scene,${th})',showinfo`, '-f', 'null', '-',
      ]);
      const times: number[] = [];
      for (const m of out.matchAll(/pts_time:([\d.]+)/g)) {
        times.push(Math.round(Number(m[1]) * 1000));
      }
      if (times.length > 0) return { timestampsMs: times, thresholdUsed: th, rescanned };
      rescanned = true;
    }
    return { timestampsMs: [], thresholdUsed: SCENE_THRESHOLD_LADDER[0], rescanned: true };
  } catch {
    return null;
  }
}
