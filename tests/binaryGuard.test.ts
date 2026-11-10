import { describe, expect, it } from 'vitest';
import { looksBinary } from '../core/decode/documentDecoder.js';

const text = (s: string) => new TextEncoder().encode(s);

describe('looksBinary 二进制守卫', () => {
  it('纯文本为 false（含中文、换行）', () => {
    expect(looksBinary(text('# 标题\n\n第一章 机器学习概述。\n普通段落。'))).toBe(false);
    expect(looksBinary(text(''))).toBe(false);
  });

  it('含 \\x00 的二进制为 true（>1% 占比）', () => {
    const buf = new Uint8Array(1000);
    buf[0] = 0x25; // '%'
    for (let i = 1; i < 20; i++) buf[i] = 0x00; // 2% \x00
    expect(looksBinary(buf)).toBe(true);
  });

  it('极低 \x00 占比（≤1%）不判为二进制（UTF-16 等编码容错）', () => {
    const buf = new Uint8Array(2000);
    buf.fill(0x61); // 全 'a'
    for (let i = 0; i < 20; i++) buf[i * 100] = 0x41;
    buf[1999] = 0x00; // 0.05%
    expect(looksBinary(buf)).toBe(false);
  });

  it('只采样前 8KB（大文件尾部 \x00 不影响判定）', () => {
    const buf = new Uint8Array(20000);
    buf.fill(0x61, 0, 10000); // 前 10KB 全 'a'（采样 8KB 内无 \x00）
    buf.fill(0x00, 10000); // 尾部全 \x00
    expect(looksBinary(buf)).toBe(false);
  });
});
