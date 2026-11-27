import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCourseMaterial } from '../core/nlp/parseCourseMaterial.js';
import { parseAbstractCollection } from '../core/nlp/parseAbstractCollection.js';
import { extractKnowledgeGraph } from '../core/graph/extractKnowledgeGraph.js';
import { buildTeachingKnowledgeBase } from '../core/kb/buildTeachingKnowledgeBase.js';
import { kbRetrieve } from '../core/kb/kbRetrieve.js';
import { buildQaKnowledgeBase } from '../core/qa/buildQaKnowledgeBase.js';
import type { TeachingKnowledgeBase } from '../core/kb/kbTypes.js';

/**
 * KAG-1 度量评测（SPEC §7 硬门槛，CC0 examples 黄金集）：
 * ① 检索质量：golden ≥30 对，kbRetrieve recall@5 ≥ 0.8（倒排+图谱基线，无 embedder）
 * ② 关联覆盖：evidence 概念挂接率 ≥90%；itemToConcept 挂接 ≥80%
 * 度量即测试：指标跌破门槛 CI 即红；报告随测试输出打印。
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function buildExamplesKb(): Promise<{ kb: TeachingKnowledgeBase; qaCount: number }> {
  const lecture = readFileSync(`${ROOT}examples/讲义-光合作用基础.md`, 'utf8');
  const parsed = await parseCourseMaterial({ content: lecture, materialType: 'md' });
  const graph = (await extractKnowledgeGraph(parsed.data!)).data!;

  const abstractsRes = parseAbstractCollection({
    content: readFileSync(`${ROOT}examples/摘要集-青年生态学论坛.txt`, 'utf8'),
    entryPattern: '^\\d{4}\\s',
  });
  if ('error' in abstractsRes) throw new Error(abstractsRes.error);
  const abstracts = abstractsRes;
  const abstractMaterial = {
    materialId: 'abstracts-2026',
    parse: {
      structuredSections: [],
      paragraphs: abstracts.records.map((r, i) => ({ index: i, text: `${r.title}。${r.body ?? ''}`, sectionOrder: 0 })),
      tables: [],
      knowledgePointCandidates: [],
      llmFilterReport: { enabled: false as const },
    } as never,
    origin: 'abstractCollection' as const,
    citation: { venue: '青年生态学论坛', year: 2026 },
  };

  const qa = await buildQaKnowledgeBase({ graph, paragraphs: parsed.data!.paragraphs });
  const qaPairs = qa.data!.qaPairs.map((q) => ({ id: q.id, question: q.question, answer: q.answer }));

  const built = buildTeachingKnowledgeBase({
    materials: [{ materialId: 'lecture-photosyn', parse: parsed.data! }, abstractMaterial],
    graph,
    qaPairs,
    options: { builtAt: '2026-11-27T00:00:00.000Z' },
  });
  return { kb: built.data!, qaCount: qaPairs.length };
}

describe('KAG-1 度量评测（SPEC §7 硬门槛）', () => {
  it('检索质量：golden ≥30 对，recall@5 ≥ 0.8（倒排+图谱基线）', async () => {
    const { kb } = await buildExamplesKb();
    // golden 对：每个有证据的概念 → (标签查询, 期望证据集)；有别名再加别名查询对
    const golden: Array<{ query: string; expectIds: string[] }> = [];
    for (const c of kb.concepts) {
      const evIds = kb.links.conceptToEvidence[c.id] ?? [];
      if (evIds.length === 0) continue;
      golden.push({ query: c.label, expectIds: evIds });
      for (const alias of c.aliases) {
        if (alias.trim().length >= 2) golden.push({ query: alias, expectIds: evIds });
      }
    }
    // 摘要集题名对：每条记录的题名查询其自身证据段（external 层检索质量观测）
    for (const ev of kb.evidence.filter((e) => e.origin === 'abstractCollection')) {
      const title = ev.text.split('。')[0];
      if (title.length >= 4) golden.push({ query: title, expectIds: [ev.id] });
    }
    // 概念双词变体对：标签 + 首证据片段词（同概念的第二查询形态）
    for (const c of kb.concepts.slice(0, 10)) {
      const evIds = kb.links.conceptToEvidence[c.id] ?? [];
      if (evIds.length === 0) continue;
      const firstEv = kb.evidence.find((e) => e.id === evIds[0]);
      const extra = firstEv?.text.match(/[一-鿿]{2,4}/g)?.find((w) => !c.label.includes(w));
      if (extra) golden.push({ query: `${c.label} ${extra}`, expectIds: evIds });
    }
    expect(golden.length).toBeGreaterThanOrEqual(30);
    let hits = 0;
    const misses: string[] = [];
    for (const g of golden) {
      const pack = kbRetrieve(kb, g.query, { topK: 5 });
      const top = new Set(pack.items.map((i) => i.evidenceId));
      if (g.expectIds.some((id) => top.has(id))) hits += 1;
      else misses.push(g.query);
    }
    const recall = hits / golden.length;
    console.log(`[KAG-1 eval] golden=${golden.length} 对，recall@5=${recall.toFixed(3)}，未命中：${misses.slice(0, 5).join('、') || '无'}`);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });

  it('关联覆盖（G5 分层口径）：corpus 挂接率 ≥90%（含章节继承）；itemToConcept ≥80%；external 如实报告', async () => {
    const { kb, qaCount } = await buildExamplesKb();
    // 分层口径（SPEC §7 评审四修订）：corpus 证据挂接率构建期可达（标签∪索引∪章节继承）；
    // external 证据与骨架概念的关联归 §4.5 采集回路（词族/LLM 提议/人工确认），构建期如实报告不设门槛
    const corpus = kb.evidence.filter((e) => e.origin === 'corpus');
    const corpusLinked = corpus.filter((e) => e.conceptIds.length > 0).length;
    const corpusRate = corpus.length > 0 ? corpusLinked / corpus.length : 0;
    const external = kb.evidence.filter((e) => e.origin !== 'corpus');
    const externalLinked = external.filter((e) => e.conceptIds.length > 0).length;
    const linkedItems = new Set(kb.links.itemToConcept.map((l) => l.itemId)).size;
    const itemRate = qaCount > 0 ? linkedItems / qaCount : 0;
    console.log(`[KAG-1 eval] corpus 挂接率=${(corpusRate * 100).toFixed(1)}%（${corpusLinked}/${corpus.length}），external 挂接=${externalLinked}/${external.length}（归采集回路），itemToConcept=${(itemRate * 100).toFixed(1)}%（${linkedItems}/${qaCount}）`);
    expect(corpusRate).toBeGreaterThanOrEqual(0.9);
    expect(itemRate).toBeGreaterThanOrEqual(0.8);
  });

  it('外部证据占比与分层正确性随度量报告（G5 观测位）', async () => {
    const { kb } = await buildExamplesKb();
    const external = kb.evidence.filter((e) => e.origin !== 'corpus');
    console.log(`[KAG-1 eval] evidence=${kb.stats.evidence}（external ${external.length}，externalRatio=${kb.stats.externalRatio.toFixed(2)}），coverageGaps=${kb.stats.coverageGaps.length}`);
    expect(external.length).toBe(7);
    expect(external.every((e) => e.origin === 'abstractCollection')).toBe(true);
  });
});
