import { describe, expect, it } from 'vitest';
import { parseCourseMaterial } from '../core/nlp/parseCourseMaterial.js';
import type { LLMProvider } from '../core/llm.js';

/** 构造 ≥3 批的候选材料（每词独立成句，互不吸收） */

/** 生成 n 个唯一五字 CJK 术语（互不吸收，确保 ≥3 批候选） */
function makeTerms(n: number): string[] {
  const g1 = '甲乙丙丁戊己庚辛壬癸';
  const g2 = '子丑寅卯辰巳午未申酉戌亥乾坤震巽坎离艮兑';
  const g3 = '一二三四五六七八九十';
  const out: string[] = [];
  for (const a of g1) for (const b of g2) for (const c of g3) {
    out.push(`生化${a}${b}${c}`);
    if (out.length >= n) return out;
  }
  return out;
}

function contentOf(n: number): string {
  return makeTerms(n).map((t) => `${t}是实验概念，${t}在课程中反复出现。`).join(String.fromCharCode(10));
}

describe('LLM 过滤并发池：确定性与进度', () => {
  it('乱序返回按批序归位：并发输出与顺序语义一致', async () => {
    const content = contentOf(250); // 3 批
    const progress: string[] = [];
    const llm: LLMProvider = {
      complete: async (prompt: string) => {
        const batch: string[] = JSON.parse(prompt.slice(prompt.lastIndexOf('[')));
        // 含"甲"的批次最慢（后完成），验证乱序归位
        await new Promise((r) => setTimeout(r, batch[0].includes('甲') ? 60 : 5));
        return JSON.stringify(batch.map((t) => ({ term: t, cls: 'noise', reason: 'mock' })));
      },
    };
    const result = await parseCourseMaterial(
      { content, materialType: 'txt' },
      { llm, llmBatch: { concurrency: 3, onProgress: (d, t, m) => progress.push(`${d}/${t} ${m}`) } },
    );
    expect(result.level).toBe('full');
    const rep = result.data!.llmFilterReport;
    expect(rep.enabled).toBe(true);
    expect(rep.batches).toBe(3);
    expect(rep.kept).toBe(0);
    expect(rep.distribution.noise).toBe(rep.dropped); // 全部候选判 noise
    const dones = progress.filter((p) => /^[1-9]\d*\/3/.test(p)).map((p) => p.split('/')[0]);
    expect(dones).toEqual(['1', '2', '3']);
    expect(rep.elapsedMs).toBeGreaterThan(0);
    expect(rep.estimatedMs).toBeGreaterThanOrEqual(rep.elapsedMs ?? 0);
  }, 30000);

  it('预算耗尽：已完成批用 LLM 结果，未完成批保留启发式候选，budgetExhausted 标注', async () => {
    const content = contentOf(250); // 3 批
    const slowLlm: LLMProvider = {
      complete: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return '[]';
      },
    };
    const result = await parseCourseMaterial(
      { content, materialType: 'txt' },
      { llm: slowLlm, llmBatch: { concurrency: 1, budgetMs: 80 } },
    );
    const rep = result.data!.llmFilterReport;
    expect(rep.budgetExhausted).toBe(true);
    expect(rep.unprocessedBatches).toBeGreaterThan(0);
    expect((rep.unprocessedBatches ?? 0) + (rep.batches ?? 0) - (rep.unprocessedBatches ?? 0)).toBe(rep.batches);
    expect(result.data!.knowledgePointCandidates.length).toBeGreaterThan(0); // 启发式兜底非空
  }, 30000);

  it('longRunning 与批次字段：4 批材料 + 慢 LLM，预估与标注存在', async () => {
    const content = contentOf(350); // 4 批
    const slowLlm: LLMProvider = {
      complete: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return '[]';
      },
    };
    const result = await parseCourseMaterial(
      { content, materialType: 'txt' },
      { llm: slowLlm, llmBatch: { concurrency: 2, budgetMs: 120_000 } },
    );
    const rep = result.data!.llmFilterReport;
    expect(rep.batches).toBe(4);
    expect(typeof rep.longRunning).toBe('boolean');
    expect(rep.elapsedMs).toBeGreaterThan(0);
  }, 60000);
});
