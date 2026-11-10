/**
 * 多语种音视频同步（sync_multilingual_av）——N3 降级实现。
 *
 * 降级形态（契约）：分语种独立输出——按语种分组的独立交付清单，
 * 不保证跨语种时码一致。音视频对齐引擎留 provider 钩子（avAlignment）。
 */
import type { SkillResult } from '../types.js';
import { renderSrt, type SubtitleTrackOut } from './synthesizeSpeech.js';

export const SYNC_MULTILINGUAL_AV_ID = 'sync_multilingual_av';

// 真实引擎钩子：宿主可注入音视频对齐 provider（逐语种音轨/字幕与画面时码对齐），
// 如 interface AvAlignmentProvider { align(video, audio, subtitles): Promise<SyncedPackage> }

export interface SyncMultilingualAvInput {
  /** 各语种字幕轨（translate_multilingual / synthesize_speech 产物） */
  tracks: SubtitleTrackOut[];
}

export interface PerLanguageDeliverable {
  lang: string;
  files: Array<{
    kind: 'subtitle';
    name: string;
    content: string;
    /** 该语种独立时码（与输入 cue 一致，不做跨语种对齐） */
    timecode: 'independent';
  }>;
}

export interface SyncMultilingualAvOutput {
  aligned: false;
  deliverables: PerLanguageDeliverable[];
  note: string;
}

export async function syncMultilingualAv(
  input: SyncMultilingualAvInput,
): Promise<SkillResult<SyncMultilingualAvOutput>> {
  const deliverables: PerLanguageDeliverable[] = input.tracks.map((track) => ({
    lang: track.lang,
    files: [
      {
        kind: 'subtitle',
        name: `course.${track.lang}.srt`,
        content: track.format === 'srt' ? track.content : renderSrt([]),
        timecode: 'independent',
      },
    ],
  }));
  return {
    skillId: SYNC_MULTILINGUAL_AV_ID,
    level: 'degraded',
    data: {
      aligned: false,
      deliverables,
      note: '音视频对齐引擎未接入，已降级为分语种独立输出（各自时码，不保证跨语种一致）',
    },
    degradationNote: '音视频对齐引擎未接入，已降级为分语种独立输出',
  };
}
