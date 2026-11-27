/**
 * KAG-1 真机 eval（env-gated 报告型，不设 CI 门槛）：
 * ① 真实 LLM planner 在多跳题集上的规划成功率/命中率（对照"完美规划"基线）；
 * ② embedder 在场时向量召回对 recall@5 的增量。
 * 无 LLM/embedder 配置时如实报告跳过——评测不产生任何写盘副作用。
 *
 * 用法：node scripts/eval-kb-reason.mjs   （需 .env 配 DEEPSEEK/MINIMAX key；embeddings 可选）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { parseCourseMaterial } = await import(join(root, 'dist/core/nlp/parseCourseMaterial.js'));
const { extractKnowledgeGraph } = await import(join(root, 'dist/core/graph/extractKnowledgeGraph.js'));
const { buildTeachingKnowledgeBase } = await import(join(root, 'dist/core/kb/buildTeachingKnowledgeBase.js'));
const { kbRetrieve } = await import(join(root, 'dist/core/kb/kbRetrieve.js'));
const { planLogicalForm } = await import(join(root, 'dist/core/kb/kbReason/lfPlanner.js'));
const { validateLogicalForm } = await import(join(root, 'dist/core/kb/kbReason/lfValidator.js'));
const { executeLogicalForm } = await import(join(root, 'dist/core/kb/kbReason/lfExecutor.js'));
const { createLlmFromEnv } = await import(join(root, 'dist/adapters/core/llmFromEnv.js'));
const { createEmbedderFromEnv } = await import(join(root, 'dist/adapters/core/embedderFromEnv.js'));
const { buildVectorIndex, queryVectorIndex } = await import(join(root, 'dist/core/kb/kbVectorIndex.js'));

const lecture = readFileSync(join(root, 'examples/讲义-光合作用基础.md'), 'utf8');
const parsed = await parseCourseMaterial({ content: lecture, materialType: 'md' });
const graph = (await extractKnowledgeGraph(parsed.data)).data;
const kb = buildTeachingKnowledgeBase({
  materials: [{ materialId: 'lec', parse: parsed.data }],
  graph,
  options: { builtAt: 'eval' },
}).data;

const QUESTIONS = [
  '哪些概念还没有证据？',
  '光反应相关概念的证据有哪些？',
  '课程里有多少个概念？',
  '碳反应的先修概念是什么？',
];

console.log('=== KAG-1 真机 eval 报告 ===');
console.log(`KB：概念 ${kb.stats.concepts}、证据 ${kb.stats.evidence}、缺口 ${kb.stats.coverageGaps.length}`);

// ① LLM planner
const llm = createLlmFromEnv();
if (!llm) {
  console.log('[planner] 无 LLM 配置（.env DEEPSEEK/MINIMAX key），跳过——reason 模式在此环境自动回落 retrieve');
} else {
  let planned = 0, valid = 0, executed = 0;
  for (const q of QUESTIONS) {
    const p = await planLogicalForm(kb, q, llm);
    if (!p.ok) { console.log(`  ✗ ${q} → 规划失败：${p.error}`); continue; }
    planned += 1;
    const v = validateLogicalForm(p.plan);
    if (!v.ok) { console.log(`  ✗ ${q} → 校验拒绝：${v.errors[0]}`); continue; }
    valid += 1;
    try {
      const r = executeLogicalForm(kb, v.plan);
      executed += 1;
      const size = r.value.type === 'number' ? r.value.value : r.value.type === 'comparison' ? 'cmp' : r.value.ids.length;
      console.log(`  ✓ ${q} → ${v.plan.op} 链，答案规模 ${size}`);
    } catch (e) {
      console.log(`  ✗ ${q} → 执行失败：${e.message}`);
    }
  }
  console.log(`[planner] 规划成功 ${planned}/${QUESTIONS.length}，校验通过 ${valid}，执行成功 ${executed}`);
}

// ② embedder 增量
const embedder = createEmbedderFromEnv();
if (!embedder) {
  console.log('[embedder] 无嵌入配置（NANGYING_EMBEDDINGS_*），跳过——检索为纯倒排基线');
} else {
  const { index } = await buildVectorIndex(kb.evidence, embedder, {});
  const golden = kb.concepts
    .filter((c) => (kb.links.conceptToEvidence[c.id] ?? []).length > 0)
    .map((c) => ({ q: c.label, expect: kb.links.conceptToEvidence[c.id] }));
  let baseHits = 0, vecHits = 0;
  for (const g of golden) {
    const base = kbRetrieve(kb, g.q, { topK: 5 });
    if (g.expect.some((id) => base.items.some((i) => i.evidenceId === id))) baseHits += 1;
    const [qv] = await embedder.embed([g.q]);
    const vs = queryVectorIndex(index, qv);
    const withVec = kbRetrieve(kb, g.q, { topK: 5, vectorScores: vs });
    if (g.expect.some((id) => withVec.items.some((i) => i.evidenceId === id))) vecHits += 1;
  }
  console.log(`[embedder] golden=${golden.length}，倒排 recall@5=${(baseHits / golden.length).toFixed(3)}，+向量=${(vecHits / golden.length).toFixed(3)}`);
}
console.log('=== 报告完（本脚本不设门槛，结果供人工研判） ===');
