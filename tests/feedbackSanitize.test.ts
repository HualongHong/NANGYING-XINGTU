import { describe, expect, it } from 'vitest';
import { sanitizeText, containsSensitive, redactionSummary } from '../core/feedback/sanitize.js';

describe('R16 反馈脱敏（sanitizeText）', () => {
  it('API key（sk-…≥16位）替换为占位符并计入清单', () => {
    const r = sanitizeText(`调用失败，key 是 sk-${'a'.repeat(24)} 请查`);
    expect(r.text).toContain('[API-key已脱敏]');
    expect(r.text).not.toContain('sk-aaaa');
    expect(r.redactions.find((x) => x.type === 'apiKey')?.count).toBe(1);
  });

  it('32+位令牌（含点号后缀）命中 token32 规则', () => {
    const r = sanitizeText(`token=${'x'.repeat(32)}.${'y'.repeat(8)}`);
    expect(r.text).toContain('[令牌已脱敏]');
    expect(r.text).not.toContain('xxxxxxxx');
  });

  it('邮箱 / IPv4 / 绝对路径 / Windows 用户路径各自脱敏', () => {
    const r = sanitizeText('联系 alice@example.com 于 10.0.0.7；日志在 /home/alice/proj/a.ts 与 C:\\Users\\bob\\log.txt');
    expect(r.text).toContain('[邮箱已脱敏]');
    expect(r.text).toContain('[IP已脱敏]');
    expect(r.text.match(/\[路径已脱敏\]/g)?.length).toBe(2);
    expect(r.text).not.toContain('alice@');
    expect(r.text).not.toContain('/home/alice');
    expect(r.text).not.toContain('C:\\Users\\bob');
  });

  it('.env 敏感赋值保留键名、替换值', () => {
    const r = sanitizeText(`我填了 DEEPSEEK_API_KEY=${'k'.repeat(20)} 到 .env`);
    expect(r.text).toContain('DEEPSEEK_API_KEY=[已脱敏]');
    expect(r.text).not.toContain('kkkk');
  });

  it('Bearer 令牌脱敏', () => {
    const r = sanitizeText(`Authorization: Bearer ${'t'.repeat(24)}`);
    expect(r.text).toBe('Authorization: Bearer [已脱敏]');
  });

  it('干净中文文本零脱敏、原文不动', () => {
    const text = '梯度下降是迭代优化方法，学习率 0.01。';
    const r = sanitizeText(text);
    expect(r.text).toBe(text);
    expect(r.redactions).toHaveLength(0);
    expect(redactionSummary(r.redactions)).toBe('无敏感形态命中');
  });

  it('containsSensitive 可重复调用（无 /g 状态污染）', () => {
    const s = `key sk-${'a'.repeat(24)}`;
    expect(containsSensitive(s)).toBe(true);
    expect(containsSensitive(s)).toBe(true);
    expect(containsSensitive('普通文本')).toBe(false);
  });

  it('多规则组合：一次扫描全量命中并确定性输出', () => {
    const input = `sk-${'a'.repeat(24)} alice@example.com /home/alice/x`;
    const r1 = sanitizeText(input);
    const r2 = sanitizeText(input);
    expect(r1.text).toBe(r2.text);
    expect(r1.redactions.map((x) => x.type)).toEqual(['apiKey', 'email', 'absPath']);
    expect(redactionSummary(r1.redactions)).toContain('API key×1');
  });
});
