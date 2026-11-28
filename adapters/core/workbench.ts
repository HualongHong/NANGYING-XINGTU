/**
 * 教师工作台（适配层）：整体运行状况聚合 + 单文件 HTML 仪表盘渲染。
 *
 * 数据源全部本地：engineStatus 引擎探测、configStore 配置（脱敏，只报名字不报值）、
 * jobQueue 异步作业、execTrace 执行轨迹、configDir()/kb/ 知识库、feedbackStore 反馈。
 * 纯只读聚合，不写任何业务数据；HTML 渲染为零依赖字符串模板（内联 SVG 图表）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { arch, platform, release } from 'node:os';
import manifest from '../../manifests/plugin.manifest.json' with { type: 'json' };
import { configDir, readConfig, readApiKey, listSecretNames } from './configStore.js';
import { listJobs, type JobSnapshot } from './jobQueue.js';
import { readTraces, type ExecTraceEntry } from './execTrace.js';
import { engineInfoOf, type EngineInfo } from './engineStatus.js';
import { listAcceptedFeedback } from './feedbackStore.js';

export interface WorkbenchReport {
  generatedAt: string;
  version: string;
  host: { platform: string; arch: string; osRelease: string; node: string };
  engines: Array<{ name: string; skillId: string } & EngineInfo>;
  settings: {
    provider?: string;
    model?: string;
    endpoint?: string;
    port?: number;
    extraKeys: string[];
    secretNames: string[];
    hasApiKey: boolean;
    llmChannel: string;
    embeddingsChannel: string;
  };
  jobs: {
    running: number;
    total: number;
    recent: Array<Pick<JobSnapshot, 'jobId' | 'skill' | 'status' | 'submittedAt' | 'elapsedMs'>>;
  };
  traces: {
    days: number;
    total: number;
    ok: number;
    successRate: number;
    skillsUsed: number;
    bySkill: Array<{ skill: string; count: number; ok: number; avgMs: number; p95Ms: number }>;
    recentErrors: Array<{ ts: string; skill: string; error: string }>;
  };
  knowledgeBases: Array<{ kbId: string; concepts: number; evidence: number; updatedAt: string; bytes: number }>;
  feedback: { total: number; unconsumed: number; byKind: Record<string, number> };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function aggregateTraces(traces: ExecTraceEntry[], days: number): WorkbenchReport['traces'] {
  const bySkill = new Map<string, { count: number; ok: number; durations: number[] }>();
  for (const t of traces) {
    const s = bySkill.get(t.skill) ?? { count: 0, ok: 0, durations: [] };
    s.count += 1;
    if (t.ok) s.ok += 1;
    s.durations.push(t.durationMs);
    bySkill.set(t.skill, s);
  }
  const rows = [...bySkill.entries()]
    .map(([skill, s]) => {
      const sorted = [...s.durations].sort((a, b) => a - b);
      const avgMs = Math.round(s.durations.reduce((a, b) => a + b, 0) / s.count);
      return { skill, count: s.count, ok: s.ok, avgMs, p95Ms: Math.round(percentile(sorted, 95)) };
    })
    .sort((a, b) => b.count - a.count);
  const ok = traces.filter((t) => t.ok).length;
  return {
    days,
    total: traces.length,
    ok,
    successRate: traces.length === 0 ? 1 : ok / traces.length,
    skillsUsed: bySkill.size,
    bySkill: rows,
    recentErrors: traces.filter((t) => !t.ok && t.error).slice(-5)
      .map((t) => ({ ts: t.ts, skill: t.skill, error: t.error! })),
  };
}

function scanKnowledgeBases(): WorkbenchReport['knowledgeBases'] {
  const root = join(configDir(), 'kb');
  if (!existsSync(root)) return [];
  const out: WorkbenchReport['knowledgeBases'] = [];
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, 'kb.json');
    if (!existsSync(file)) continue;
    try {
      const kb = JSON.parse(readFileSync(file, 'utf8')) as {
        kbId?: string; concepts?: unknown[]; evidence?: unknown[];
      };
      out.push({
        kbId: kb.kbId ?? dir,
        concepts: Array.isArray(kb.concepts) ? kb.concepts.length : 0,
        evidence: Array.isArray(kb.evidence) ? kb.evidence.length : 0,
        updatedAt: statSync(file).mtime.toISOString(),
        bytes: statSync(file).size,
      });
    } catch {
      out.push({ kbId: dir, concepts: 0, evidence: 0, updatedAt: '', bytes: 0 });
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** 聚合工作台报告（days 为轨迹统计窗口，默认 30 天） */
export async function buildWorkbenchReport(opts: { days?: number } = {}): Promise<WorkbenchReport> {
  const days = opts.days ?? 30;
  const config = readConfig();
  const extra = (config?.extra ?? {}) as Record<string, unknown>;
  const [ocr, ffmpeg] = await Promise.all([
    engineInfoOf('parse_course_material', ''),
    engineInfoOf('qa_media', ''),
  ]);
  const jobs = listJobs();
  const feedback = listAcceptedFeedback();
  const byKind: Record<string, number> = {};
  for (const e of feedback.entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    version: manifest.version,
    host: { platform: platform(), arch: arch(), osRelease: release(), node: process.version },
    engines: [
      { name: 'OCR（扫描件摄取）', skillId: 'parse_course_material', ...(ocr ?? { status: 'builtin' as const }) },
      { name: 'ffmpeg（媒体检查）', skillId: 'qa_media', ...(ffmpeg ?? { status: 'optional-not-installed' as const }) },
    ],
    settings: {
      provider: config?.provider,
      model: config?.model,
      endpoint: config?.endpoint,
      port: typeof extra.port === 'number' ? extra.port : undefined,
      extraKeys: Object.keys(extra).sort(),
      secretNames: listSecretNames(),
      hasApiKey: readApiKey() !== undefined,
      llmChannel: process.env.NANGYING_MCP_LLM === '1' ? 'env NANGYING_MCP_LLM=1'
        : extra.llm ? 'settings extra.llm' : '未启用（启发式降级）',
      embeddingsChannel: process.env.NANGYING_MCP_EMBEDDINGS === '1' ? 'env NANGYING_MCP_EMBEDDINGS=1'
        : extra.embeddings ? 'settings extra.embeddings' : '未启用（纯倒排检索）',
    },
    jobs: {
      running: jobs.filter((j) => j.status === 'running').length,
      total: jobs.length,
      recent: jobs.slice(0, 10).map((j) => ({
        jobId: j.jobId, skill: j.skill, status: j.status,
        submittedAt: j.submittedAt, elapsedMs: j.elapsedMs,
      })),
    },
    traces: aggregateTraces(readTraces({ days }), days),
    knowledgeBases: scanKnowledgeBases(),
    feedback: {
      total: feedback.entries.length,
      unconsumed: feedback.entries.filter((e) => !e.consumed).length,
      byKind,
    },
  };
}

// ---------- HTML 仪表盘（单文件零依赖，内联 SVG） ----------

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function barChart(rows: Array<{ label: string; value: number }>, width = 640, barH = 22): string {
  if (rows.length === 0) return '<p class="muted">暂无数据</p>';
  const max = Math.max(...rows.map((r) => r.value), 1);
  const labelW = 220;
  const chartW = width - labelW - 60;
  const height = rows.length * (barH + 6) + 4;
  const bars = rows.map((r, i) => {
    const y = i * (barH + 6) + 2;
    const w = Math.max(2, Math.round((r.value / max) * chartW));
    return `<text x="${labelW - 8}" y="${y + barH - 7}" text-anchor="end" class="bl">${esc(r.label)}</text>` +
      `<rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="3" class="bar"/>` +
      `<text x="${labelW + w + 6}" y="${y + barH - 7}" class="bv">${r.value}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img">${bars}</svg>`;
}

const STATUS_COLOR: Record<string, string> = {
  builtin: '#16a34a', 'optional-not-installed': '#d97706', 'not-provided': '#9ca3af',
};
const STATUS_LABEL: Record<string, string> = {
  builtin: '内置可用', 'optional-not-installed': '可选未装', 'not-provided': '官方未接入',
};
const JOB_COLOR: Record<string, string> = {
  running: '#2563eb', done: '#16a34a', error: '#dc2626', cancelled: '#9ca3af', interrupted: '#d97706',
};

/** 渲染单文件 HTML 仪表盘（全部数据内联，无外部资源，可离线打开） */
export function renderWorkbenchHtml(r: WorkbenchReport): string {
  const rate = (r.traces.successRate * 100).toFixed(1);
  const engineCards = r.engines.map((e) => `
    <div class="card">
      <div class="card-title">${esc(e.name)}</div>
      <div><span class="dot" style="background:${STATUS_COLOR[e.status] ?? '#9ca3af'}"></span>${STATUS_LABEL[e.status] ?? esc(e.status)}</div>
      ${e.detail ? `<div class="muted">${esc(e.detail)}</div>` : ''}
      ${e.installHint ? `<div class="hint">安装指引：${esc(e.installHint)}</div>` : ''}
    </div>`).join('');
  const skillRows = r.traces.bySkill.slice(0, 20).map((s) => `
    <tr><td>${esc(s.skill)}</td><td>${s.count}</td><td>${s.ok}</td>
    <td>${s.count > 0 ? ((s.ok / s.count) * 100).toFixed(0) : 0}%</td><td>${s.avgMs}</td><td>${s.p95Ms}</td></tr>`).join('');
  const jobRows = r.jobs.recent.map((j) => `
    <tr><td class="mono">${esc(j.jobId.slice(0, 8))}…</td><td>${esc(j.skill)}</td>
    <td><span class="dot" style="background:${JOB_COLOR[j.status] ?? '#9ca3af'}"></span>${esc(j.status)}</td>
    <td>${esc(j.submittedAt)}</td><td>${j.elapsedMs ?? '—'}</td></tr>`).join('');
  const kbRows = r.knowledgeBases.map((k) => `
    <tr><td>${esc(k.kbId)}</td><td>${k.concepts}</td><td>${k.evidence}</td>
    <td>${(k.bytes / 1024).toFixed(1)} KB</td><td>${esc(k.updatedAt.slice(0, 19).replace('T', ' '))}</td></tr>`).join('');
  const errList = r.traces.recentErrors.map((e) => `
    <li><span class="mono">${esc(e.ts.slice(0, 19).replace('T', ' '))}</span> <b>${esc(e.skill)}</b>：${esc(e.error)}</li>`).join('');
  const kindList = Object.entries(r.feedback.byKind).map(([k, v]) => `${esc(k)} × ${v}`).join('、') || '暂无';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>囊萤星图 · 教师工作台</title>
<style>
  body{font-family:system-ui,"Microsoft YaHei","PingFang SC",sans-serif;margin:0;background:#f3f4f6;color:#111827}
  header{background:#1e3a5f;color:#fff;padding:20px 28px}
  header h1{margin:0;font-size:20px} header .sub{opacity:.75;font-size:12px;margin-top:6px}
  main{max-width:1080px;margin:0 auto;padding:20px}
  section{background:#fff;border-radius:10px;padding:18px 22px;margin-bottom:18px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  h2{font-size:16px;margin:0 0 12px;border-left:4px solid #1e3a5f;padding-left:10px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
  .card{border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px}
  .card-title{font-weight:600;margin-bottom:6px}
  .stat{font-size:26px;font-weight:700} .muted{color:#6b7280;font-size:12px} .hint{color:#b45309;font-size:12px;margin-top:4px}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left}
  th{background:#f9fafb} .mono{font-family:ui-monospace,monospace;font-size:12px}
  .bar{fill:#3b82f6} .bl{font-size:12px;fill:#374151} .bv{font-size:12px;fill:#6b7280}
  ul.err{padding-left:18px;font-size:13px} ul.err li{margin-bottom:6px}
</style></head><body>
<header>
  <h1>囊萤星图 · 教师工作台</h1>
  <div class="sub">版本 ${esc(r.version)} ｜ ${esc(r.host.platform)}/${esc(r.host.arch)}（${esc(r.host.osRelease)}）｜ Node ${esc(r.host.node)} ｜ 生成于 ${esc(r.generatedAt.slice(0, 19).replace('T', ' '))}</div>
</header>
<main>
<section><h2>引擎状态</h2><div class="grid">${engineCards}
  <div class="card"><div class="card-title">LLM 通道</div><div>${esc(r.settings.llmChannel)}</div>
    <div class="muted">向量嵌入：${esc(r.settings.embeddingsChannel)}</div></div>
  <div class="card"><div class="card-title">配置</div>
    <div>${esc(r.settings.provider ?? '未配置 provider')}${r.settings.model ? ` / ${esc(r.settings.model)}` : ''}</div>
    <div class="muted">密钥：${r.settings.secretNames.length > 0 ? esc(r.settings.secretNames.join('、')) : '未配置'}（值不展示）</div>
    ${r.settings.port ? `<div class="muted">HTTP 端口：${r.settings.port}</div>` : ''}</div>
</div></section>
<section><h2>执行统计（近 ${r.traces.days} 天）</h2>
  <div class="grid">
    <div class="card"><div class="card-title">总调用</div><div class="stat">${r.traces.total}</div></div>
    <div class="card"><div class="card-title">成功率</div><div class="stat">${rate}%</div><div class="muted">${r.traces.ok}/${r.traces.total} 成功</div></div>
    <div class="card"><div class="card-title">使用技能数</div><div class="stat">${r.traces.skillsUsed}</div></div>
    <div class="card"><div class="card-title">异步作业</div><div class="stat">${r.jobs.running}</div><div class="muted">运行中 ｜ 累计 ${r.jobs.total}</div></div>
  </div>
  <h2 style="margin-top:16px">技能调用分布</h2>
  ${barChart(r.traces.bySkill.slice(0, 10).map((s) => ({ label: s.skill, value: s.count })))}
  <table><thead><tr><th>技能</th><th>调用</th><th>成功</th><th>成功率</th><th>平均耗时(ms)</th><th>P95(ms)</th></tr></thead>
  <tbody>${skillRows || '<tr><td colspan="6" class="muted">暂无轨迹数据（技能调用后自动记录）</td></tr>'}</tbody></table>
</section>
<section><h2>异步作业（最近 ${r.jobs.recent.length} 条）</h2>
  <table><thead><tr><th>作业</th><th>技能</th><th>状态</th><th>提交时间</th><th>耗时(ms)</th></tr></thead>
  <tbody>${jobRows || '<tr><td colspan="5" class="muted">暂无异步作业</td></tr>'}</tbody></table>
</section>
<section><h2>教学知识库（${r.knowledgeBases.length}）</h2>
  <table><thead><tr><th>KB</th><th>概念数</th><th>证据数</th><th>体积</th><th>更新时间</th></tr></thead>
  <tbody>${kbRows || '<tr><td colspan="5" class="muted">尚未构建知识库（build_teaching_knowledge_base）</td></tr>'}</tbody></table>
</section>
<section><h2>反馈闭环</h2>
  <div class="grid">
    <div class="card"><div class="card-title">已入库反馈</div><div class="stat">${r.feedback.total}</div></div>
    <div class="card"><div class="card-title">未消化</div><div class="stat">${r.feedback.unconsumed}</div><div class="muted">submit_feedback approve 后进入 loop 监控</div></div>
  </div>
  <p class="muted">类型分布：${kindList}</p>
</section>
<section><h2>最近错误</h2>
  ${errList ? `<ul class="err">${errList}</ul>` : '<p class="muted">近窗口内无错误记录</p>'}
</section>
</main></body></html>`;
}
