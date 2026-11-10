/**
 * 数字人授课视频生成（generate_digital_human_video）——N3 降级实现。
 *
 * 降级形态（契约）：PPT + 字幕视频"制作清单"——每 scene 一页幻灯片描述
 * + 时码字幕轨 + 合成参数 JSON，可交给外部工具执行。
 * 真实视频生成/口型同步引擎留 provider 钩子（videoGeneration/lipSync）。
 */
import type { SkillResult } from '../types.js';
import type { TeachingScript } from '../course/generateTeachingScript.js';
import { renderSrt } from './synthesizeSpeech.js';

export const GENERATE_DIGITAL_HUMAN_VIDEO_ID = 'generate_digital_human_video';

// 真实引擎钩子：宿主可注入视频生成 provider（制作清单 → 渲染任务），
// 如 interface VideoGenerationProvider { render(spec: ProductionList): Promise<{videoUrl}> }

export interface GenerateDigitalHumanVideoInput {
  script: TeachingScript;
  avatarId?: string;
  sceneConfig?: Record<string, unknown>;
}

export interface ProductionList {
  mode: 'ppt-subtitle';
  slides: Array<{
    sceneId: string;
    lessonId: string;
    phase: string;
    title: string;
    /** 幻灯片画面内容描述 */
    visual: string;
    /** 讲解词（叠印在讲者备注） */
    voiceover: string;
    durationSeconds: number;
  }>;
  subtitleTrack: string;
  renderParams: {
    resolution: string;
    fps: number;
    background: string;
    avatar: string;
  };
}

export async function generateDigitalHumanVideo(
  input: GenerateDigitalHumanVideoInput,
): Promise<SkillResult<ProductionList>> {
  const scenes = input.script.storyboardScript.flatMap((l) => l.scenes);
  const slides = scenes.map((scene) => ({
    sceneId: scene.id,
    lessonId: scene.lessonId,
    phase: scene.phase,
    title: `${scene.lessonId} · ${scene.phase}`,
    visual: scene.visual,
    voiceover: scene.voiceover,
    durationSeconds: scene.minutes * 60,
  }));
  const data: ProductionList = {
    mode: 'ppt-subtitle',
    slides,
    subtitleTrack: renderSrt(
      input.script.subtitleScript.filter((c) => c.text.trim() !== ''),
    ),
    renderParams: {
      resolution: '1280x720',
      fps: 25,
      background: 'fixed-classroom',
      avatar: input.avatarId ?? 'none（PPT 翻页模式，无数字人出镜）',
    },
  };
  return {
    skillId: GENERATE_DIGITAL_HUMAN_VIDEO_ID,
    level: 'degraded',
    data,
    degradationNote: '视频生成/口型同步引擎未接入，已降级为 PPT+字幕视频制作清单',
  };
}
