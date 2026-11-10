/**
 * 多教师数字分身协同（orchestrate_multi_teacher）——N3 降级实现。
 *
 * 降级形态（契约）：单教师模式——全部授课片段由主讲教师独立完成。
 * 多分身调度引擎留 provider 钩子（multiAvatarOrchestration）。
 */
import type { SkillResult } from '../types.js';

export const ORCHESTRATE_MULTI_TEACHER_ID = 'orchestrate_multi_teacher';

// 真实引擎钩子：宿主可注入多分身调度 provider，
// 如 interface MultiAvatarOrchestrationProvider { schedule(plan): Promise<ShotSchedule> }

export interface TeacherRef {
  name: string;
  role?: string;
}

export interface LessonSegment {
  segmentId: string;
  title: string;
  minutes: number;
}

export interface OrchestrateMultiTeacherInput {
  teachers: TeacherRef[];
  lessonSegments: LessonSegment[];
}

export interface SingleTeacherPlan {
  mode: 'single-teacher';
  /** 主讲教师（teachers 第一位） */
  primaryTeacher: string;
  /** 单教师执行序列 */
  assignments: Array<{
    segmentId: string;
    title: string;
    teacher: string;
    minutes: number;
  }>;
  note: string;
}

export async function orchestrateMultiTeacher(
  input: OrchestrateMultiTeacherInput,
): Promise<SkillResult<SingleTeacherPlan>> {
  const primary = input.teachers[0]?.name ?? '主讲教师';
  const data: SingleTeacherPlan = {
    mode: 'single-teacher',
    primaryTeacher: primary,
    assignments: input.lessonSegments.map((seg) => ({
      segmentId: seg.segmentId,
      title: seg.title,
      teacher: primary,
      minutes: seg.minutes,
    })),
    note:
      input.teachers.length > 1
        ? `原计划 ${input.teachers.length} 位教师协同；多分身调度引擎未接入，降级为${primary}单教师模式。`
        : `单教师模式：${primary}独立完成全部 ${input.lessonSegments.length} 个授课片段。`,
  };
  return {
    skillId: ORCHESTRATE_MULTI_TEACHER_ID,
    level: 'degraded',
    data,
    degradationNote: '多分身调度引擎未接入，已降级为单教师模式',
  };
}
