import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  splitTopLevelBlocks,
  findMcpBlock,
  install,
  uninstall,
  MCP_ID,
  // @ts-expect-error .mjs 无类型声明，导出为运行时纯函数（vitest 可直接导入）
} from '../scripts/install-dsh.mjs';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 伪造 profile：含注释与 !!js 表达式的最小 cordis.patch.yml */
function fakeProfile(): string {
  const d = mkdtempSync(join(tmpdir(), 'ny-dsh-profile-'));
  dirs.push(d);
  writeFileSync(join(d, 'cordis.patch.yml'), [
    '# 顶层注释（安装不得破坏）',
    '- id: ui-settings-general',
    '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
    '  config: { welcomeNoticeVersion: 2026-08-13.1 } # 行尾注释',
    '- id: expr-demo',
    '  config:',
    '    value: !!js/env PROCESS_ENV_VALUE',
    '',
  ].join('\n'), 'utf8');
  return d;
}

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const ENTRY = 'D:\\dist\\server\\mcp.js';

describe('install-dsh 文本操作', () => {
  it('splitTopLevelBlocks 识别顶层块（忽略缩进的列表项）', () => {
    const text = readFileSync(join(fakeProfile(), 'cordis.patch.yml'), 'utf8');
    const { lines, blocks } = splitTopLevelBlocks(text);
    // 块边界为行号区间（bodies 需经 lines 取）
    const bodies = blocks.map((b: { start: number; end: number }) => lines.slice(b.start, b.end).join(String.fromCharCode(10)));
    // 文件头注释不属于任何顶层块（保留在文本中，由 install 追加语义保证不破坏）
    expect(text).toContain('顶层注释');
    expect(bodies.some((b: string) => b.includes('ui-settings-general'))).toBe(true);
    expect(bodies.some((b: string) => b.includes('expr-demo'))).toBe(true);
  });

  it('安装→重复安装不重复插入且更新路径→卸载移除，注释与 !!js 保留', async () => {
    const dir = fakeProfile();
    const file = join(dir, 'cordis.patch.yml');

    const r1 = install(dir, { nodePath: NODE, entryPath: ENTRY });
    expect(r1.action).toBe('installed');
    expect(readFileSync(file, 'utf8')).toContain(`id: ${MCP_ID}`);
    // 备份已生成
    expect(readdirSync(dir).some((f) => f.startsWith('cordis.patch.yml.bak-'))).toBe(true);

    // 第二次安装：路径相同 → unchanged
    const r2 = install(dir, { nodePath: NODE, entryPath: ENTRY });
    expect(r2.action).toBe('unchanged');
    expect(readFileSync(file, 'utf8').match(/id: mcp-nangying-starmap/g)).toHaveLength(1);

    // 路径变化 → updated，仍只有一块
    const r3 = install(dir, { nodePath: NODE, entryPath: 'E:\\other\\mcp.js' });
    expect(r3.action).toBe('updated');
    const text3 = readFileSync(file, 'utf8');
    expect(text3.match(/id: mcp-nangying-starmap/g)).toHaveLength(1);
    expect(text3).toContain('E:\\\\other\\\\mcp.js');

    // 注释与 !!js 未被破坏
    expect(text3).toContain('顶层注释（安装不得破坏）');
    expect(text3).toContain('!!js/env PROCESS_ENV_VALUE');
    expect(text3).toContain('行尾注释');

    // 卸载：块移除、其余内容保留
    const r4 = uninstall(dir);
    expect(r4.action).toBe('removed');
    const text4 = readFileSync(file, 'utf8');
    expect(text4).not.toContain(MCP_ID);
    expect(text4).toContain('ui-settings-general');
    expect(text4).toContain('!!js/env');
    // 再次卸载幂等
    expect(uninstall(dir).action).toBe('absent');
  });

  it('findMcpBlock 未注册时返回 null', () => {
    const text = readFileSync(join(fakeProfile(), 'cordis.patch.yml'), 'utf8');
    expect(findMcpBlock(text)).toBeNull();
  });
});

describe('install-dsh 注册块自检与路径一致性（P1-4 / P1-8）', () => {
  const installOnce = (dir: string) =>
    install(dir, { nodePath: NODE, entryPath: ENTRY });

  it('字段缺失/类型错：逐条列出问题与修复建议', async () => {
    // @ts-expect-error .mjs 无类型声明
    const { validateBlock } = await import('../scripts/install-dsh.mjs');
    const dir = fakeProfile();
    installOnce(dir);
    const file = join(dir, 'cordis.patch.yml');
    let text = readFileSync(file, 'utf8');
    // 制造三类缺陷：serverName 非法字符、toolCallTimeoutMs 非正整数、删除 args 行
    text = text.replace('serverName: nangying_starmap', 'serverName: bad name!!')
      .replace('toolCallTimeoutMs: 900000', 'toolCallTimeoutMs: -5')
      .split('\n').filter((l: string) => !l.trim().startsWith('args:')).join('\n');
    const issues = validateBlock(text);
    const fields = issues.map((i: { field: string }) => i.field);
    expect(fields).toContain('serverName');
    expect(fields).toContain('toolCallTimeoutMs');
    expect(fields).toContain('args');
    for (const it of issues) {
      expect(it.issue.length).toBeGreaterThan(0);
      expect(it.fix.length).toBeGreaterThan(0);
    }
  });

  it('路径不一致：注册 args 指向旧仓库路径时 checkStatus.pathMatchesPluginRoot=false', async () => {
    // @ts-expect-error .mjs 无类型声明
    const { checkStatus } = await import('../scripts/install-dsh.mjs');
    const dir = fakeProfile();
    installOnce(dir);
    // 篡改 args 中的盘符（模拟仓库移动后的旧注册）
    const file = join(dir, 'cordis.patch.yml');
    const text = readFileSync(file, 'utf8').replace('D:\\\\dist\\\\server\\\\mcp.js', 'E:\\\\old-dist\\\\server\\\\mcp.js');
    writeFileSync(file, text, 'utf8');
    const s = checkStatus(dir);
    expect(s.pathMatchesPluginRoot).toBe(false);
    expect(s.blockIssues).toEqual([]); // 字段本身合规
  });
});
