/**
 * 反馈闭环监控（loop engineering 的自我监控指标端）：
 * 读取 .nangying-feedback/index.jsonl（submit_feedback approve 入库的索引），
 * 计算指标并对 manifests/loop.thresholds.json 的门槛求值。
 *
 * 零 TS 依赖（CI 在 typecheck/test 前也可运行）：直接解析 index.jsonl 行。
 * 语义：
 *   - 样本量 < minFeedbackBeforeGating：门槛未激活，exit 0（CI 无反馈库也安全）；
 *   - 激活后任一指标超阈：打印 breach 清单，exit 1（开发门槛的硬强制）；
 *   - --consume <docId>：维护者消化标记（转 backlog/修复后置 consumed，退出未消化计数）；
 *   - --json：仅输出指标 JSON（供其他工具消费）。
 *
 * 用法：node scripts/feedback-loop.mjs [--root dir] [--json] [--consume docId]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_THRESHOLDS = {
  minFeedbackBeforeGating: 3,
  maxUnconsumedIssues: 8,
  maxSensitiveAttachedRatio: 0.25,
  stalenessWarnDays: 30,
};

export function loadThresholds(file = join(repoRoot, 'manifests', 'loop.thresholds.json')) {
  if (!existsSync(file)) return { ...DEFAULT_THRESHOLDS };
  try {
    return { ...DEFAULT_THRESHOLDS, ...(JSON.parse(readFileSync(file, 'utf8'))) };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

/** 读取 index.jsonl（坏行跳过进 warnings） */
export function loadIndex(rootDir) {
  const file = join(rootDir, 'index.jsonl');
  const entries = [];
  const warnings = [];
  if (!existsSync(file)) return { entries, warnings };
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try {
      const e = JSON.parse(t);
      if (e && typeof e.docId === 'string') entries.push(e);
      else warnings.push(`第 ${i + 1} 行缺少 docId`);
    } catch {
      warnings.push(`第 ${i + 1} 行 JSON 解析失败`);
    }
  });
  return { entries, warnings };
}

/** 自我监控指标（纯函数；now 可注入便于测试） */
export function computeMetrics(entries, now = new Date()) {
  const byKind = {};
  let sensitiveCount = 0;
  let unconsumedIssues = 0;
  let oldestUnconsumedAgeDays = 0;
  for (const e of entries) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    if (e.hasSensitive) sensitiveCount += 1;
    if ((e.kind === 'install_issue' || e.kind === 'usage_issue') && !e.consumed) {
      unconsumedIssues += 1;
      const ageMs = now.getTime() - new Date(e.acceptedAt).getTime();
      const ageDays = Math.floor(ageMs / 86_400_000);
      if (ageDays > oldestUnconsumedAgeDays) oldestUnconsumedAgeDays = ageDays;
    }
  }
  const total = entries.length;
  return {
    total,
    byKind,
    sensitiveCount,
    sensitiveRatio: total === 0 ? 0 : sensitiveCount / total,
    unconsumedIssues,
    oldestUnconsumedAgeDays,
    consumed: entries.filter((e) => e.consumed).length,
  };
}

/** 门槛求值：样本量不足 → active=false（跳过）；否则逐项比对 */
export function evaluateThresholds(metrics, thresholds) {
  const active = metrics.total >= thresholds.minFeedbackBeforeGating;
  if (!active) {
    return { active, breaches: [], note: `已接受反馈 ${metrics.total} 条 < 门槛激活线 ${thresholds.minFeedbackBeforeGating}：指标仅供参考，门槛待激活` };
  }
  const breaches = [];
  if (metrics.unconsumedIssues > thresholds.maxUnconsumedIssues) {
    breaches.push({
      metric: 'unconsumedIssues',
      value: metrics.unconsumedIssues,
      threshold: thresholds.maxUnconsumedIssues,
      message: `未消化问题（install_issue/usage_issue 未标记 consumed）${metrics.unconsumedIssues} 条 > 门槛 ${thresholds.maxUnconsumedIssues}：积压超限，触发 backlog 评审`,
    });
  }
  if (metrics.sensitiveRatio > thresholds.maxSensitiveAttachedRatio) {
    breaches.push({
      metric: 'sensitiveAttachedRatio',
      value: Number(metrics.sensitiveRatio.toFixed(3)),
      threshold: thresholds.maxSensitiveAttachedRatio,
      message: `敏感附件占比 ${(metrics.sensitiveRatio * 100).toFixed(1)}% > 门槛 ${(thresholds.maxSensitiveAttachedRatio * 100).toFixed(0)}%：审阅纪律告警，确认是否滥用调试通道`,
    });
  }
  if (metrics.oldestUnconsumedAgeDays > thresholds.stalenessWarnDays) {
    breaches.push({
      metric: 'oldestUnconsumedAgeDays',
      value: metrics.oldestUnconsumedAgeDays,
      threshold: thresholds.stalenessWarnDays,
      message: `最老未消化问题已 ${metrics.oldestUnconsumedAgeDays} 天 > 门槛 ${thresholds.stalenessWarnDays} 天：反馈滞留，需闭环处理或显式放弃（--consume）`,
    });
  }
  return { active, breaches };
}

function consume(rootDir, docId) {
  const { entries } = loadIndex(rootDir);
  const idx = entries.findIndex((e) => e.docId === docId);
  if (idx < 0) return false;
  entries[idx] = { ...entries[idx], consumed: true };
  writeFileSync(
    join(rootDir, 'index.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
  return true;
}

function parseArgs(argv) {
  const args = { root: join(repoRoot, '.nangying-feedback'), json: false, consume: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--root') { i += 1; args.root = argv[i]; }
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--consume') { i += 1; args.consume = argv[i]; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.consume) {
    const ok = consume(args.root, args.consume);
    if (!ok) {
      console.error(`feedback-loop：未找到 ${args.consume}（index.jsonl 无此 docId）`);
      process.exit(2);
    }
    console.log(`feedback-loop：${args.consume} 已标记 consumed（退出未消化计数）`);
    return;
  }
  const thresholds = loadThresholds();
  const { entries, warnings } = loadIndex(args.root);
  const metrics = computeMetrics(entries);
  const verdict = evaluateThresholds(metrics, thresholds);
  if (args.json) {
    console.log(JSON.stringify({ metrics, verdict, thresholds, warnings }, null, 2));
  } else {
    console.log('=== 囊萤星图 · 反馈闭环指标 ===');
    console.log(`已接受反馈：${metrics.total} 条（已消化 ${metrics.consumed}）`);
    console.log(`分类：${Object.entries(metrics.byKind).map(([k, v]) => `${k}=${v}`).join('，') || '（无）'}`);
    console.log(`敏感附件：${metrics.sensitiveCount} 条（${(metrics.sensitiveRatio * 100).toFixed(1)}%）`);
    console.log(`未消化问题：${metrics.unconsumedIssues} 条（最老 ${metrics.oldestUnconsumedAgeDays} 天）`);
    for (const w of warnings) console.log(`  警告：${w}`);
    if (!verdict.active) {
      console.log(`\n门槛未激活：${verdict.note}`);
    } else if (verdict.breaches.length === 0) {
      console.log('\n门槛全部通过：反馈闭环健康');
    } else {
      console.error('\n门槛 breach（开发准入被拦截，先闭环反馈再开发）：');
      for (const b of verdict.breaches) console.error(`  - ${b.message}`);
    }
  }
  process.exit(verdict.active && verdict.breaches.length > 0 ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
