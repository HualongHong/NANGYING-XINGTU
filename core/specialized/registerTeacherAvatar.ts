/**
 * 教师数字分身注册（register_teacher_avatar）——N3 降级实现。
 *
 * 降级形态（契约）：静态头像 + 文字讲稿。
 * 真实数字人建模/声音克隆引擎留 provider 钩子（digitalHuman/voiceCloning），
 * 宿主注入后可升级为 full；当前产出可演示的分身档案中间态。
 */
import type { SkillResult } from '../types.js';

export const REGISTER_TEACHER_AVATAR_ID = 'register_teacher_avatar';

// 真实引擎钩子：宿主可注入数字人建模 provider（建模素材 → 3D/2D 分身），
// 如 interface DigitalHumanProvider { model(profile: TeacherProfile): Promise<{avatarId}> }

export interface TeacherProfile {
  name: string;
  bio?: string;
  style?: string;
  appearancePreference?: string;
}

export interface RegisterAvatarInput {
  teacherProfile: TeacherProfile;
  avatarMaterials?: string[];
  voiceSamples?: string[];
}

export interface AvatarProfile {
  avatar: {
    type: 'static';
    /** 静态头像占位描述（可交给外部工具绘制） */
    description: string;
    materials: string[];
  };
  voice: { type: 'none'; note: string };
  profile: TeacherProfile;
  registeredMaterials: { avatarMaterials: string[]; voiceSamples: string[] };
}

export async function registerTeacherAvatar(
  input: RegisterAvatarInput,
): Promise<SkillResult<AvatarProfile>> {
  const { teacherProfile, avatarMaterials = [], voiceSamples = [] } = input;
  const style = teacherProfile.style ?? '亲和严谨';
  const data: AvatarProfile = {
    avatar: {
      type: 'static',
      description:
        `静态头像占位：${teacherProfile.name}（授课风格：${style}` +
        `${teacherProfile.appearancePreference ? `，形象偏好：${teacherProfile.appearancePreference}` : ''}）` +
        '——正式形象待数字人建模引擎接入后替换',
      materials: avatarMaterials,
    },
    voice: { type: 'none', note: '未接入声音克隆引擎，语音合成技能将退化为纯字幕输出' },
    profile: teacherProfile,
    registeredMaterials: { avatarMaterials, voiceSamples },
  };
  return {
    skillId: REGISTER_TEACHER_AVATAR_ID,
    level: 'degraded',
    data,
    degradationNote: '数字人建模/声音克隆引擎未接入，已降级为静态头像 + 文字讲稿',
  };
}
