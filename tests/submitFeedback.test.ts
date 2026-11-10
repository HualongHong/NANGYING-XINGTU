import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAdapter } from '../adapters/core/local.adapter.js';
import { listAcceptedFeedback, loadAcceptedDocument } from '../adapters/core/feedbackStore.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ny-feedback-'));
  process.env.NANGYING_FEEDBACK_DIR = dir;
});
afterEach(() => {
  delete process.env.NANGYING_FEEDBACK_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('R16 反馈协调（submit_feedback）', () => {
  it('prepare：生成脱敏草稿，绝不落盘', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('submit_feedback', {
      inputs: {
        stage: 'prepare',
        kind: 'install_issue',
        summary: '安装报错',
        detail: `联系 alice@example.com，日志在 /home/alice/proj；key sk-${'a'.repeat(24)}`,
        context: 'Node 22 / pnpm 12 / Ubuntu',
      },
    });
    expect(r.level).toBe('full');
    const d = r.data as { draft: Record<string, unknown>; redactionSummary: string };
    expect(String(d.draft.docId)).toMatch(/^fb-/);
    expect(d.redactionSummary).toContain('API key');
    expect(d.redactionSummary).toContain('邮箱');
    expect(JSON.stringify(d.draft)).not.toContain('alice@');
    // 审阅门声明存在
    expect(String(d.draft.reviewGate)).toContain('未入库');
    // 绝不落盘：存储目录不存在
    expect(existsSync(join(dir, 'accepted'))).toBe(false);
    expect(existsSync(join(dir, 'index.jsonl'))).toBe(false);
  });

  it('prepare：kind 非法 / summary 缺失 → INVALID_INPUT，不落盘', async () => {
    const adapter = new LocalAdapter();
    const bad = await adapter.invokeSkill('submit_feedback', {
      inputs: { stage: 'prepare', kind: 'wrong_kind', summary: 'x' },
    });
    expect(bad.level).toBe('unavailable');
    expect(bad.errorCode).toBe('INVALID_INPUT');
    expect(bad.degradationNote).toContain('kind 非法');
    const empty = await adapter.invokeSkill('submit_feedback', {
      inputs: { stage: 'prepare', kind: 'usage_issue', summary: '  ' },
    });
    expect(empty.degradationNote).toContain('summary 必填');
    expect(existsSync(join(dir, 'accepted'))).toBe(false);
  });

  it('prepare：敏感片段默认忽略，includeSensitive=true 才进「敏感附件」', async () => {
    const adapter = new LocalAdapter();
    const off = await adapter.invokeSkill('submit_feedback', {
      inputs: { stage: 'prepare', kind: 'usage_issue', summary: '调试需要', sensitiveExcerpt: 'sk-live-secret' },
    });
    const offData = off.data as { draft: { sensitive?: unknown; reviewGate: string } };
    expect(offData.draft.sensitive).toBeUndefined();
    expect(offData.draft.reviewGate).toContain('已按默认脱敏策略忽略');
    const on = await adapter.invokeSkill('submit_feedback', {
      inputs: { stage: 'prepare', kind: 'usage_issue', summary: '调试需要', includeSensitive: true, sensitiveExcerpt: 'sk-live-secret' },
    });
    const onData = on.data as { draft: { sensitive: { excerpt: string; note: string } } };
    expect(onData.draft.sensitive.excerpt).toBe('sk-live-secret');
    expect(onData.draft.sensitive.note).toContain('显式');
  });

  it('approve：approved 非 true 一律拒绝储存（审阅门）', async () => {
    const adapter = new LocalAdapter();
    const prep = await adapter.invokeSkill('submit_feedback', {
      inputs: { stage: 'prepare', kind: 'install_issue', summary: '安装报错' },
    });
    const draft = (prep.data as { draft: unknown }).draft;
    for (const approved of [undefined, false, 'false']) {
      const r = await adapter.invokeSkill('submit_feedback', {
        inputs: { stage: 'approve', draft, approved },
      });
      expect(r.level).toBe('unavailable');
      expect(r.errorCode).toBe('INVALID_INPUT');
      expect(r.degradationNote).toContain('审阅门拒绝');
    }
    expect(existsSync(join(dir, 'accepted'))).toBe(false);
  });

  it('approve：审阅通过后入库，索引可回流 loop；审阅编辑引入的敏感形态再脱敏兜底', async () => {
    const adapter = new LocalAdapter();
    const prep = await adapter.invokeSkill('submit_feedback', {
      inputs: { stage: 'prepare', kind: 'praise', summary: '图谱提取很准', detail: '教材章节结构完整保留' },
    });
    const draft = (prep.data as { draft: Record<string, unknown> }).draft;
    // 用户审阅时补充了联系方式（应被 approve 二次脱敏）
    draft.detail = '教材章节结构完整保留；可联系 bob@example.com 交流';
    const r = await adapter.invokeSkill('submit_feedback', {
      inputs: { stage: 'approve', draft, approved: true, reviewComment: '信息已核实' },
    });
    expect(r.level).toBe('full');
    const stored = (r.data as { stored: boolean; path: string; docId: string });
    expect(stored.stored).toBe(true);
    expect(existsSync(stored.path)).toBe(true);

    const doc = loadAcceptedDocument(stored.docId, dir)!;
    expect(doc.kind).toBe('praise');
    expect(doc.detail).toContain('[邮箱已脱敏]');
    expect(doc.detail).not.toContain('bob@');
    expect(doc.reviewComment).toBe('信息已核实');
    expect(doc.source).toBe('submit_feedback');

    const { entries } = listAcceptedFeedback(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].hasSensitive).toBe(false);
    expect(entries[0].summary).toBe('图谱提取很准');
    expect(readdirSync(join(dir, 'accepted'))).toHaveLength(1);
  });

  it('approve：显式敏感附件随文档入库并标记 hasSensitive', async () => {
    const adapter = new LocalAdapter();
    const prep = await adapter.invokeSkill('submit_feedback', {
      inputs: {
        stage: 'prepare', kind: 'usage_issue', summary: '日志含密钥',
        includeSensitive: true, sensitiveExcerpt: `sk-${'z'.repeat(24)}`,
      },
    });
    const draft = (prep.data as { draft: unknown }).draft;
    const r = await adapter.invokeSkill('submit_feedback', {
      inputs: { stage: 'approve', draft, approved: true },
    });
    const docId = (r.data as { docId: string }).docId;
    const raw = readFileSync(join(dir, 'accepted', `${docId}.json`), 'utf8');
    expect(raw).toContain('敏感附件');
    const { entries } = listAcceptedFeedback(dir);
    expect(entries[0].hasSensitive).toBe(true);
  });

  it('approve：draft 缺失/非对象 → INVALID_INPUT', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('submit_feedback', {
      inputs: { stage: 'approve', approved: true },
    });
    expect(r.level).toBe('unavailable');
    expect(r.degradationNote).toContain('draft 必填');
  });
});
