/**
 * LF 确定性校验器（SPEC §4.6）：未知算子/参数非法/超深/超算子数一律拒——
 * 拒绝即由调用方回落 retrieve 模式并如实说明。纯函数零 LLM。
 */
import { KB_LIMITS } from '../kbSchema.js';
import { LF_OPERATORS, isLfNode, measureLf, type LfNode } from './lfGrammar.js';

export type LfValidation = { ok: true; plan: LfNode } | { ok: false; errors: string[] };

export function validateLogicalForm(plan: unknown): LfValidation {
  const errors: string[] = [];
  if (!isLfNode(plan)) {
    return { ok: false, errors: ['逻辑式须为 { op, args } 对象'] };
  }
  const { ops, depth } = measureLf(plan);
  if (ops > KB_LIMITS.maxPlanOps) {
    errors.push(`算子数 ${ops} 超上限 ${KB_LIMITS.maxPlanOps}`);
  }
  if (depth > KB_LIMITS.maxTraverseDepth + 1) {
    errors.push(`嵌套深度 ${depth} 超上限 ${KB_LIMITS.maxTraverseDepth + 1}`);
  }
  const walk = (node: LfNode, path: string): void => {
    const decl = LF_OPERATORS.get(node.op);
    if (!decl) {
      errors.push(`${path}：未知算子 ${node.op}（白名单：${[...LF_OPERATORS.keys()].join('/')}）`);
      return;
    }
    if (typeof node.args !== 'object' || node.args === null) {
      errors.push(`${path}.${node.op}：args 须为对象`);
      return;
    }
    const err = decl.checkArgs(node.args);
    if (err) errors.push(`${path}.${node.op}：${err}`);
    for (const [k, v] of Object.entries(node.args)) {
      const children: unknown[] = Array.isArray(v) ? v : [v];
      for (const c of children) {
        if (isLfNode(c)) walk(c, `${path}.${node.op}.${k}`);
      }
    }
  };
  walk(plan, '$');
  return errors.length > 0 ? { ok: false, errors } : { ok: true, plan };
}
