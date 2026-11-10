/**
 * 多场景智能匹配切换（match_teaching_scene）——N3 降级实现。
 *
 * 降级形态（契约）：固定背景——全部教学环节使用统一默认背景。
 * 场景库/视频合成引擎留 provider 钩子（sceneLibrary/videoComposition）。
 */
import type { SkillResult } from '../types.js';
import type { TeachingScript } from '../course/generateTeachingScript.js';

export const MATCH_TEACHING_SCENE_ID = 'match_teaching_scene';

// 真实引擎钩子：宿主可注入场景库与视频合成 provider，
// 如 interface SceneLibraryProvider { match(segment): Promise<Scene> }

export const FIXED_BACKGROUND = 'fixed-classroom（固定教室背景：浅绿板书墙 + 木质讲台）';

export interface MatchTeachingSceneInput {
  script: TeachingScript;
}

export interface SceneAssignment {
  sceneId: string;
  phase: string;
  background: string;
}

export interface MatchTeachingSceneOutput {
  mode: 'fixed-background';
  background: string;
  assignments: SceneAssignment[];
  /** 降级形态无场景切换；接入场景库后此处输出切换点与转场方式 */
  transitions: [];
}

export async function matchTeachingScene(
  input: MatchTeachingSceneInput,
): Promise<SkillResult<MatchTeachingSceneOutput>> {
  const scenes = input.script.storyboardScript.flatMap((l) => l.scenes);
  const data: MatchTeachingSceneOutput = {
    mode: 'fixed-background',
    background: FIXED_BACKGROUND,
    assignments: scenes.map((scene) => ({
      sceneId: scene.id,
      phase: scene.phase,
      background: FIXED_BACKGROUND,
    })),
    transitions: [],
  };
  return {
    skillId: MATCH_TEACHING_SCENE_ID,
    level: 'degraded',
    data,
    degradationNote: '场景库/视频合成引擎未接入，已降级为固定背景',
  };
}
