import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseSrt,
  auditSubtitleTimeline,
  mergeEngineFindings,
  finalizeReport,
} from '../core/qa/mediaAudit.js';
import { probeFfmpegAvailable } from '../adapters/core/mediaProbe.js';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

const dirs: string[] = [];
afterAll(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const GOOD_SRT = '1\n00:00:00,000 --> 00:00:02,000\n种群密度是数量特征\n\n2\n00:00:02,500 --> 00:00:05,000\n标志重捕法用于调查';
const BAD_SRT = [
  '1\n00:00:03,000 --> 00:00:01,000\n回绕：end<start',           // wrap
  '2\n00:00:02,000 --> 00:00:04,000\n与第1条重叠',               // overlap with #1? #1 end 1s…按 start 排序前按出现序
  '3\n00:00:20,000 --> 00:00:22,000\n\n',                       // gap 16s + empty text
].join('\n\n');

describe('R7-4 qa_media：字幕时间轴静态检查（纯函数，永远可用）', () => {
  it('parseSrt 解析时间码（逗号毫秒）', () => {
    const cues = parseSrt(GOOD_SRT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ index: 1, startMs: 0, endMs: 2000 });
    expect(cues[1].startMs).toBe(2500);
  });

  it('健康字幕无 high 发现', () => {
    const findings = auditSubtitleTimeline(parseSrt(GOOD_SRT));
    expect(findings.filter((f) => f.severity === 'high')).toHaveLength(0);
  });

  it('回绕/重叠/超长静默/空文本全部识别', () => {
    const findings = auditSubtitleTimeline(parseSrt(BAD_SRT));
    const types = findings.map((f) => f.type);
    expect(types).toContain('subtitle_wrap');
    expect(types).toContain('subtitle_gap');
    expect(types).toContain('subtitle_empty');
    const wrap = findings.find((f) => f.type === 'subtitle_wrap')!;
    expect(wrap.severity).toBe('high');
    expect(wrap.message).toContain('end');
  });

  it('重叠区间检测', () => {
    const srt = '1\n00:00:00,000 --> 00:00:05,000\n甲\n\n2\n00:00:03,000 --> 00:00:06,000\n乙';
    const findings = auditSubtitleTimeline(parseSrt(srt));
    expect(findings.some((f) => f.type === 'subtitle_overlap')).toBe(true);
  });

  it('mergeEngineFindings：关键帧密度过低与静音占比过高', () => {
    const withKf = mergeEngineFindings([], { durationMs: 60_000 }, [1000], undefined, 60_000);
    expect(withKf.some((f) => f.type === 'no_keyframe')).toBe(true);
    const withSil = mergeEngineFindings([], { durationMs: 20_000 }, [1000, 5000, 9000], [[0, 9000]], 20_000);
    expect(withSil.some((f) => f.type === 'silence_heavy')).toBe(true);
    const report = finalizeReport({ engine: 'ffmpeg', findings: withSil });
    expect(report.stats.medium).toBeGreaterThanOrEqual(1);
  });
});

describe('R7-4 qa_media：适配器（引擎门控）', () => {
  it('纯字幕检查（无 mediaFile）：引擎可用 full，回绕/重叠进 findings', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('qa_media', {
      inputs: { subtitles: '1\n00:00:03,000 --> 00:00:01,000\n回绕\n\n2\n00:00:02,000 --> 00:00:04,000\n重叠' },
    });
    expect(r.level).toBe('full');
    const data = r.data as { findings: Array<{ type: string }>; cueCount: number };
    expect(data.cueCount).toBe(2);
    expect(data.findings.some((f) => f.type === 'subtitle_wrap')).toBe(true);
  });

  it('无 mediaFile 且无字幕 → unavailable + 安装指引（诚实）', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('qa_media', { inputs: {} });
    // 有引擎时走 full 分支但无检查项；断言结构化不抛异常且形态合法
    expect(['unavailable', 'full']).toContain(r.level);
    if (r.level === 'unavailable') expect(r.degradationNote).toContain('ffmpeg');
  });
});

describe('R7-4 qa_media：真实 ffmpeg 端到端（本机有引擎才跑）', () => {
  let hasEngine = false;
  let videoDir = '';
  beforeAll(async () => {
    hasEngine = await probeFfmpegAvailable();
    if (!hasEngine) return;
    videoDir = mkdtempSync(join(tmpdir(), 'ny-qa-media-'));
    dirs.push(videoDir);
    // 4s 动态测试图（无静音；场景渐变，用于元数据断言）
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=10', '-pix_fmt', 'yuv420p', join(videoDir, 'motion.mp4')], { timeout: 60_000 });
    // 3 段纯色硬切（红/蓝/绿）：高场景分，用于关键帧检测
    execFileSync('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=red:duration=1:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'color=blue:duration=1:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'color=green:duration=1:size=320x240:rate=10',
      '-filter_complex', 'concat=n=3:v=1:a=0', '-pix_fmt', 'yuv420p', join(videoDir, 'cuts.mp4')], { timeout: 60_000 });
    // 4s 纯黑静音（静音占比 100%）
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:size=320x240:duration=4', '-f', 'lavfi', '-i', 'anullsrc=r=44100', '-shortest', '-pix_fmt', 'yuv420p', join(videoDir, 'silent.mp4')], { timeout: 60_000 });
  }, 120_000);

  it('场景切换关键帧：硬切视频检出切换点（cuts.mp4 真跑）', async () => {
    if (!hasEngine) return;
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('qa_media', {
      inputs: { mediaFile: join(videoDir, 'cuts.mp4'), checks: { silence: false } },
    });
    expect(r.level).toBe('full');
    const data = r.data as {
      video: { width: number; height: number; durationMs: number };
      keyframeTimestampsMs: number[];
    };
    expect(data.video.width).toBe(320);
    expect(data.video.height).toBe(240);
    expect(data.video.durationMs).toBeGreaterThan(2500);
    expect(data.keyframeTimestampsMs.length).toBeGreaterThanOrEqual(2); // 红→蓝、蓝→绿
  }, 90_000);

  it('ffprobe 元数据（motion.mp4 真跑）', async () => {
    if (!hasEngine) return;
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('qa_media', {
      inputs: { mediaFile: join(videoDir, 'motion.mp4'), checks: { keyframes: false, silence: false } },
    });
    const data = r.data as { engine: string; video: { durationMs: number; codec?: string } };
    expect(data.engine).toBe('ffmpeg');
    expect(data.video.durationMs).toBeGreaterThan(3000);
  }, 90_000);

  it('静音段检测：anullsrc 全静音 → silence_heavy 发现（真跑）', async () => {
    if (!hasEngine) return;
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('qa_media', {
      inputs: { mediaFile: join(videoDir, 'silent.mp4'), checks: { keyframes: false } },
    });
    const data = r.data as { findings: Array<{ type: string }>; silenceSegmentsMs: Array<[number, number]> };
    expect(data.findings.some((f) => f.type === 'silence_heavy')).toBe(true);
    expect(data.silenceSegmentsMs.length).toBeGreaterThan(0);
  }, 90_000);
});

describe('R11-2 qa_media：渐变画面场景阈值自适应（真 ffmpeg）', () => {
  it('mergeEngineFindings：复扫命中注明降级阈值；全零诚实报告不伪造（纯函数）', () => {
    const hit = mergeEngineFindings([], { durationMs: 60_000 }, [1200, 9000], undefined, 60_000, { thresholdUsed: 0.15, rescanned: true });
    const fb = hit.find((f) => f.type === 'scene_threshold_fallback')!;
    expect(fb.severity).toBe('low');
    expect(fb.message).toContain('0.3 → 0.15');
    expect(fb.message).toContain('2 个切换点');
    const zero = mergeEngineFindings([], { durationMs: 60_000 }, [], undefined, 60_000, { thresholdUsed: 0.3, rescanned: true });
    const zf = zero.find((f) => f.type === 'scene_threshold_fallback')!;
    expect(zf.message).toContain('全程渐变');
    expect(zf.message).toContain('不伪造');
    // 首轮即命中（rescanned=false）→ 无降级注明
    const clean = mergeEngineFindings([], { durationMs: 60_000 }, [500, 1500, 2500], undefined, 60_000, { thresholdUsed: 0.3, rescanned: false });
    expect(clean.some((f) => f.type === 'scene_threshold_fallback')).toBe(false);
  });

  let hasEngine = false;
  let videoDir = '';
  beforeAll(async () => {
    hasEngine = await probeFfmpegAvailable();
    if (!hasEngine) return;
    videoDir = mkdtempSync(join(tmpdir(), 'ny-qa-r11-'));
    dirs.push(videoDir);
    // 渐变素材：黑白 0.8s 线性淡入——首轮 0.3 检不出，0.15 复扫命中（实测锁定）
    execFileSync('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=black:duration=1:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'color=white:duration=1:size=320x240:rate=10',
      '-filter_complex', '[0][1]xfade=transition=fade:duration=0.8:offset=0.3,format=yuv420p',
      join(videoDir, 'fade.mp4')], { timeout: 60_000 });
    // 全程静态素材：任何阈值都为零 → 诚实报告路径
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=gray:duration=4:size=320x240:rate=10', '-pix_fmt', 'yuv420p', join(videoDir, 'static.mp4')], { timeout: 60_000 });
  }, 120_000);

  it('渐变素材：0.3 未命中 → 0.15 复扫检出 + sceneScan 注明降级阈值（真跑）', async () => {
    if (!hasEngine) return;
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('qa_media', {
      inputs: { mediaFile: join(videoDir, 'fade.mp4'), checks: { silence: false } },
    });
    expect(r.level).toBe('full');
    const data = r.data as {
      keyframeTimestampsMs: number[];
      sceneScan: { thresholdUsed: number; rescanned: boolean };
      findings: Array<{ type: string; message: string }>;
    };
    expect(data.sceneScan.rescanned).toBe(true);
    expect(data.sceneScan.thresholdUsed).toBeLessThan(0.3);
    expect(data.keyframeTimestampsMs.length).toBeGreaterThanOrEqual(1);
    const fb = data.findings.find((f) => f.type === 'scene_threshold_fallback')!;
    expect(fb.message).toContain('画面渐变');
    expect(fb.message).toContain(`0.3 → ${data.sceneScan.thresholdUsed}`);
  }, 90_000);

  it('全程静态素材：复扫仍为零 → 诚实报告"无显著场景切换（或全程渐变）"，不伪造（真跑）', async () => {
    if (!hasEngine) return;
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('qa_media', {
      inputs: { mediaFile: join(videoDir, 'static.mp4'), checks: { silence: false } },
    });
    const data = r.data as {
      keyframeTimestampsMs: number[];
      sceneScan: { thresholdUsed: number; rescanned: boolean };
      findings: Array<{ type: string; message: string }>;
    };
    expect(data.sceneScan.rescanned).toBe(true);
    expect(data.keyframeTimestampsMs).toHaveLength(0);
    const fb = data.findings.find((f) => f.type === 'scene_threshold_fallback')!;
    expect(fb.message).toContain('未检出显著场景切换');
    expect(fb.message).toContain('不伪造');
  }, 90_000);
});
