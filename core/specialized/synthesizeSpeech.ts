/**
 * 多语种语音合成（synthesize_speech）——N3 降级实现。
 *
 * 降级形态（契约）：纯字幕输出——由 TeachingScript 的字幕轨渲染 SRT 文本。
 * 真实 TTS 引擎留 provider 钩子（ttsEngine），宿主注入后升级为 full。
 */
import type { SkillResult } from '../types.js';
import type { TeachingScript } from '../course/generateTeachingScript.js';

export const SYNTHESIZE_SPEECH_ID = 'synthesize_speech';

// 真实引擎钩子：宿主可注入 TTS provider（文本+声音档案 → 音轨），
// 如 interface TtsProvider { synthesize(text: string, opts: {lang, voice?}): Promise<AudioTrack> }

export interface SynthesizeSpeechInput {
  script: TeachingScript;
  lang?: string;
}

export interface SubtitleTrackOut {
  lang: string;
  format: 'srt';
  content: string;
}

export interface SynthesizeSpeechOutput {
  /** 降级产物：纯字幕（SRT 文本） */
  subtitleTracks: SubtitleTrackOut[];
  /** 音轨为空（无 TTS 引擎） */
  audioTracks: [];
}

/** 分钟数 → SRT 时码 HH:MM:SS,mmm（确定性，取整到秒） */
export function toSrtTimecode(minutes: number): string {
  const totalMs = Math.round(minutes * 60 * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** 字幕 cue 列表渲染为 SRT 文本（纯函数、确定性） */
export function renderSrt(
  cues: Array<{ startMinute: number; minutes: number; text: string }>,
): string {
  return cues
    .map((cue, i) =>
      [
        String(i + 1),
        `${toSrtTimecode(cue.startMinute)} --> ${toSrtTimecode(cue.startMinute + cue.minutes)}`,
        cue.text,
      ].join('\n'),
    )
    .join('\n\n');
}

export async function synthesizeSpeech(
  input: SynthesizeSpeechInput,
): Promise<SkillResult<SynthesizeSpeechOutput>> {
  const lang = input.lang ?? 'zh';
  const cues = input.script.subtitleScript.filter((c) => c.text.trim() !== '');
  const content = renderSrt(cues);
  return {
    skillId: SYNTHESIZE_SPEECH_ID,
    level: 'degraded',
    data: {
      subtitleTracks: cues.length > 0 ? [{ lang, format: 'srt', content }] : [],
      audioTracks: [],
    },
    degradationNote: 'TTS 引擎未接入，已降级为纯字幕输出（SRT）',
  };
}
