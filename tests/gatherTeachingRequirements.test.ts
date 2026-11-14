import { describe, expect, it } from 'vitest';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import {
  REQUIREMENT_QUESTIONS,
  buildRequirementsReport,
  classifyConstraint,
  planRequirements,
} from '../core/course/gatherTeachingRequirements.js';

const FULL = {
  courseMeta: '土壤学 · 第 3 章 · 王老师',
  knowledgeStructure: { sections: ['3.1 质地'], keyPoints: ['团粒结构'] },
  abstractCollection: '/data/摘要集.pdf',
  template: '默认模板',
  teachingParams: { hours: 2, doubleSided: true },
  depthAndPlan: { deepen: 'moderate', planFormat: 'table' },
  casePreferences: { organize: '原文+解说', introTags: 2 },
  extraOutputs: { editableSlides: false },
};

describe('gather_teaching_requirements（教学需求治理）', () => {
  it('八问全答：stopWork=false，清单全 answered', () => {
    const r = buildRequirementsReport({ answers: FULL });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.stopWork).toBe(false);
    expect(r.checklist).toHaveLength(REQUIREMENT_QUESTIONS.length);
    expect(r.checklist.every((i) => i.status === 'answered')).toBe(true);
    expect(r.blockingMissing).toEqual([]);
    expect(r.toCollect).toEqual([]);
  });

  it('缺 Q1–Q3 硬停工：blockingMissing 列出且 stopWork=true', () => {
    const r = buildRequirementsReport({ answers: { template: '默认模板' } });
    if ('error' in r) throw new Error('unexpected');
    expect(r.stopWork).toBe(true);
    expect(r.blockingMissing).toEqual(['Q1', 'Q2', 'Q3']);
    expect(r.toCollect).toEqual(['Q5', 'Q6', 'Q7', 'Q8']);
    expect(r.assumptionsUsed).toEqual([]);
  });

  it('Q4 缺答不算 blocking/collect，记入 assumptionsUsed（默认模板须复述）', () => {
    const r = buildRequirementsReport({
      answers: { ...FULL, template: undefined },
    });
    if ('error' in r) throw new Error('unexpected');
    expect(r.blockingMissing).toEqual([]);
    expect(r.toCollect).toEqual([]);
    expect(r.stopWork).toBe(true);
    expect(r.assumptionsUsed).toHaveLength(1);
    expect(r.assumptionsUsed[0].note).toContain('复述');
  });

  it('迭代沿用：未重答项给 carriedOver，确认后不再要求复述', () => {
    const prior = { courseMeta: FULL.courseMeta, teachingParams: FULL.teachingParams };
    const unconfirmed = buildRequirementsReport({ answers: {}, priorAnswers: prior });
    if ('error' in unconfirmed) throw new Error('unexpected');
    const carry = unconfirmed.checklist.filter((i) => i.carriedOver);
    expect(carry.map((i) => i.key).sort()).toEqual(['courseMeta', 'teachingParams']);
    expect(carry.every((i) => i.carriedOver!.needsRestate)).toBe(true);
    const confirmed = buildRequirementsReport({ answers: {}, priorAnswers: prior, confirmedCarryOver: ['Q1'] });
    if ('error' in confirmed) throw new Error('unexpected');
    expect(confirmed.checklist.find((i) => i.id === 'Q1')!.carriedOver!.needsRestate).toBe(false);
    expect(confirmed.checklist.find((i) => i.id === 'Q5')!.carriedOver!.needsRestate).toBe(true);
  });

  it('口径变更：本轮回答与上轮不同给 changed 标注', () => {
    const r = buildRequirementsReport({
      answers: { casePreferences: '一篇摘要=一个案例' },
      priorAnswers: { casePreferences: '主题式归纳' },
    });
    if ('error' in r) throw new Error('unexpected');
    const changed = r.checklist.find((i) => i.key === 'casePreferences')!;
    expect(changed.changed).toEqual({ prior: '主题式归纳' });
  });

  it('纠偏登记：字段齐全入登记表，replay 可回放', () => {
    const r = buildRequirementsReport({
      answers: FULL,
      corrections: [
        { quote: '学生材料里不要出现课时安排', content: '学生可见文本不得出现课时节奏' },
        { quote: '第 3 章只要 4 个案例', content: '第 3 章课堂前沿拓展只保留 4 个案例' },
      ],
    });
    if ('error' in r) throw new Error('unexpected');
    expect(r.constraintRegistry).toHaveLength(2);
    expect(r.constraintRegistry[0].layer).toBe('H');
    expect(r.constraintRegistry[1].layer).toBe('P');
    expect(r.replay).toHaveLength(2);
    expect(r.replay[0].status).toBe('active');
  });

  it('纠偏缺 content 拒绝并指明原因', () => {
    const r = buildRequirementsReport({ answers: FULL, corrections: [{ quote: '只要一句' }] });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('content');
  });

  it('classifyConstraint：显式 layer 优先，auto 拿不准归 P', () => {
    expect(classifyConstraint(' anything ', 'H')).toBe('H');
    expect(classifyConstraint('anything', 'x')).toHaveProperty('error');
    expect(classifyConstraint('学生可见文本不得出现评分锚点')).toBe('H');
    expect(classifyConstraint('第 3 章用 4 个案例')).toBe('P');
  });

  it('planRequirements：corrections 非对象条目报错', () => {
    const p = planRequirements({ corrections: ['不是对象'] });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toContain('corrections[0]');
  });

  it('执行器冒烟：LocalAdapter 调用返回清单与登记表', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('gather_teaching_requirements', {
      inputs: { answers: FULL, corrections: [{ quote: 'q', content: '学生可见文本不得出现模板名' }] },
    });
    expect(r.level).toBe('full');
    const data = r.data as { stopWork: boolean; checklist: unknown[]; constraintRegistry: unknown[] };
    expect(data.stopWork).toBe(false);
    expect(data.checklist).toHaveLength(8);
    expect(data.constraintRegistry).toHaveLength(1);
  });
});
