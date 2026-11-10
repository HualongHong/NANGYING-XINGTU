import { describe, expect, it } from 'vitest';
import { registerTeacherAvatar } from '../../core/specialized/registerTeacherAvatar.js';
import { synthesizeSpeech, toSrtTimecode, renderSrt } from '../../core/specialized/synthesizeSpeech.js';
import { generateDigitalHumanVideo } from '../../core/specialized/generateDigitalHumanVideo.js';
import { orchestrateMultiTeacher } from '../../core/specialized/orchestrateMultiTeacher.js';
import { matchTeachingScene } from '../../core/specialized/matchTeachingScene.js';
import { syncMultilingualAv } from '../../core/specialized/syncMultilingualAv.js';
import type { TeachingScript } from '../../core/course/generateTeachingScript.js';

const SCRIPT: TeachingScript = {
  storyboardScript: [
    {
      lessonId: 'les-1',
      title: '监督学习',
      scenes: [
        {
          id: 'scene-1', lessonId: 'les-1', phase: '导入', sceneType: '标题卡',
          visual: '画面：标题卡', voiceover: '同学们好。', subtitle: '同学们好。',
          minutes: 2, startMinute: 0, conceptIds: [],
        },
        {
          id: 'scene-2', lessonId: 'les-1', phase: '讲解', sceneType: 'PPT展示',
          visual: '画面：PPT', voiceover: '接下来我们看梯度下降。', subtitle: '接下来我们看梯度下降。',
          minutes: 8, startMinute: 2, conceptIds: ['con-b'],
        },
      ],
    },
  ],
  voiceoverScript: [{ lessonId: 'les-1', title: '监督学习', text: '同学们好。\n接下来我们看梯度下降。' }],
  subtitleScript: [
    { lessonId: 'les-1', sceneId: 'scene-1', startMinute: 0, minutes: 2, text: '同学们好。' },
    { lessonId: 'les-1', sceneId: 'scene-2', startMinute: 2, minutes: 8, text: '接下来我们看梯度下降。' },
  ],
};

describe('register_teacher_avatar（降级：静态头像）', () => {
  it('输出静态头像档案，level=degraded，字段完整', async () => {
    const r = await registerTeacherAvatar({
      teacherProfile: { name: '王老师', style: '亲和严谨', appearancePreference: '正装' },
      avatarMaterials: ['photos/front.png'],
    });
    expect(r.level).toBe('degraded');
    expect(r.data!.avatar.type).toBe('static');
    expect(r.data!.avatar.description).toContain('王老师');
    expect(r.data!.avatar.description).toContain('正装');
    expect(r.data!.voice.type).toBe('none');
    expect(r.data!.registeredMaterials.avatarMaterials).toEqual(['photos/front.png']);
  });

  it('确定性：两次输出一致', async () => {
    const input = { teacherProfile: { name: '李老师' } };
    const a = await registerTeacherAvatar(input);
    const b = await registerTeacherAvatar(input);
    expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
  });
});

describe('synthesize_speech（降级：纯字幕 SRT）', () => {
  it('SRT 时码格式正确（00:00:00,000 样式，入参为分钟）', () => {
    expect(toSrtTimecode(0)).toBe('00:00:00,000');
    expect(toSrtTimecode(2)).toBe('00:02:00,000');
    expect(toSrtTimecode(62.5)).toBe('01:02:30,000');
    const srt = renderSrt([{ startMinute: 0, minutes: 2, text: '你好' }]);
    expect(srt).toContain('00:00:00,000 --> 00:02:00,000');
    expect(srt.startsWith('1\n')).toBe(true);
  });

  it(' TeachingScript 渲染 SRT，level=degraded，audioTracks 为空', async () => {
    const r = await synthesizeSpeech({ script: SCRIPT, lang: 'zh' });
    expect(r.level).toBe('degraded');
    expect(r.data!.audioTracks).toEqual([]);
    expect(r.data!.subtitleTracks).toHaveLength(1);
    expect(r.data!.subtitleTracks[0].content).toContain('接下来我们看梯度下降');
    expect(r.data!.subtitleTracks[0].content).toContain('00:02:00,000 --> 00:10:00,000');
  });
});

describe('generate_digital_human_video（降级：PPT+字幕制作清单）', () => {
  it('每 scene 一页幻灯片 + 时码字幕 + 合成参数', async () => {
    const r = await generateDigitalHumanVideo({ script: SCRIPT, avatarId: 'avatar-1' });
    expect(r.level).toBe('degraded');
    expect(r.data!.mode).toBe('ppt-subtitle');
    expect(r.data!.slides).toHaveLength(2);
    expect(r.data!.slides[1].durationSeconds).toBe(480);
    expect(r.data!.slides[1].visual).toContain('PPT');
    expect(r.data!.renderParams.resolution).toBe('1280x720');
    expect(r.data!.renderParams.avatar).toBe('avatar-1');
    expect(r.data!.subtitleTrack).toContain('00:00:00,000');
  });

  it('确定性：两次输出一致', async () => {
    const a = await generateDigitalHumanVideo({ script: SCRIPT });
    const b = await generateDigitalHumanVideo({ script: SCRIPT });
    expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
  });
});

describe('orchestrate_multi_teacher（降级：单教师模式）', () => {
  it('多教师计划降级为主讲单教师序列', async () => {
    const r = await orchestrateMultiTeacher({
      teachers: [{ name: '王老师', role: '主讲' }, { name: '李老师', role: '答疑' }],
      lessonSegments: [
        { segmentId: 'seg-1', title: '导入', minutes: 5 },
        { segmentId: 'seg-2', title: '讲解', minutes: 20 },
      ],
    });
    expect(r.level).toBe('degraded');
    expect(r.data!.mode).toBe('single-teacher');
    expect(r.data!.primaryTeacher).toBe('王老师');
    expect(r.data!.assignments.every((x) => x.teacher === '王老师')).toBe(true);
    expect(r.data!.note).toContain('单教师');
  });
});

describe('match_teaching_scene（降级：固定背景）', () => {
  it('全部环节配固定背景，无切换点', async () => {
    const r = await matchTeachingScene({ script: SCRIPT });
    expect(r.level).toBe('degraded');
    expect(r.data!.mode).toBe('fixed-background');
    expect(r.data!.assignments).toHaveLength(2);
    expect(r.data!.assignments.every((a) => a.background === r.data!.background)).toBe(true);
    expect(r.data!.transitions).toEqual([]);
  });
});

describe('sync_multilingual_av（降级：分语种独立输出）', () => {
  it('按语种分组交付清单，aligned=false', async () => {
    const srt = renderSrt([{ startMinute: 0, minutes: 2, text: 'hello' }]);
    const r = await syncMultilingualAv({
      tracks: [
        { lang: 'zh', format: 'srt', content: srt },
        { lang: 'en', format: 'srt', content: srt },
      ],
    });
    expect(r.level).toBe('degraded');
    expect(r.data!.aligned).toBe(false);
    expect(r.data!.deliverables.map((d) => d.lang)).toEqual(['zh', 'en']);
    expect(r.data!.deliverables[0].files[0].name).toBe('course.zh.srt');
    expect(r.data!.deliverables[0].files[0].timecode).toBe('independent');
  });
});
