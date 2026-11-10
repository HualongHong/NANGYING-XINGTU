import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ny-doctor-'));
  dirs.push(d);
  return d;
}

describe('install-dsh 主动预配置（doctor / preset / setup-llm）', () => {
  it('doctor 报告结构：伪造环境下各项状态与可修复标记正确', async () => {
    // @ts-expect-error .mjs 无类型声明
    const { runDoctor } = await import('../scripts/install-dsh.mjs');
    const root = tempDir();
    // 伪造：dist 缺失 + 源码存在（触发产物 fail）
    writeFileSync(join(root, 'core-dummy.txt'), 'x');
    const profileDir = join(tempDir(), 'no-such-profile');
    const d = runDoctor({ pluginRoot: root, distEntry: join(root, 'dist', 'server', 'mcp.js'), profileDir });
    const byId: Map<string, { status: string }> = new Map(d.items.map((i: { id: string; status: string }) => [i.id, i]));
    expect(byId.get('dist')!.status).toBe('fail');
    expect(byId.get('dsh-profile')!.status).toBe('warn');
    expect(byId.get('llm')!.status).toBe('warn'); // 无 .env/settings
    expect(d.items.every((i: { id: string; label: string; status: string; detail: string }) =>
      typeof i.label === 'string' && typeof i.detail === 'string')).toBe(true);
  });

  it('installPreset：幂等追加 preset 块，已存在则跳过', async () => {
    // @ts-expect-error .mjs 无类型声明
    const { installPreset } = await import('../scripts/install-dsh.mjs');
    // 伪造插件根：含 dsh/preset 交付文件
    const root = tempDir();
    rmSync(root, { recursive: true, force: true });
    const presetSrc = join(root, 'dsh');
    // 用真实仓库的交付文件（只读）
    const { cpSync } = await import('node:fs');
    cpSync('dsh', presetSrc, { recursive: true });
    // 伪造 profile
    const profileDir = join(tempDir(), 'desktop');
    // 需要 main 同级的 cordis.patch.yml
    const profDir = tempDir();
    writeFileSync(join(profDir, 'cordis.patch.yml'), '# 头注释\n- id: x\n  config: 1\n', 'utf8');

    const r1 = installPreset(profDir, { pluginRoot: root });
    expect(r1.action).toBe('installed');
    const text1 = readFileSync(join(profDir, 'cordis.patch.yml'), 'utf8');
    expect(text1).toContain('id: preset-teaching-assistant');
    expect(text1).toContain('头注释'); // 原内容保留
    expect(text1.match(/id: preset-teaching-assistant/g)).toHaveLength(1);

    const r2 = installPreset(profDir, { pluginRoot: root });
    expect(r2.action).toBe('skipped');
    expect(readFileSync(join(profDir, 'cordis.patch.yml'), 'utf8').match(/id: preset-teaching-assistant/g)).toHaveLength(1);
  });

  it('setupLlmParam：参数模式写 settings/secrets（临时配置目录），返回值不含 key', async () => {
    // @ts-expect-error .mjs 无类型声明
    const { setupLlmParam } = await import('../scripts/install-dsh.mjs');
    const cfgDir = tempDir();
    process.env.NANGYING_CONFIG_DIR = cfgDir;
    process.env.DEEPSEEK_API_KEY = 'fake-key-doctor-test-123456';
    const r = await setupLlmParam({ provider: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' });
    expect(r.provider).toBe('deepseek');
    expect(r.model).toBe('deepseek-flash');
    expect(JSON.stringify(r)).not.toContain('fake-key-doctor-test-123456');
    const settings = JSON.parse(readFileSync(join(cfgDir, 'settings.json'), 'utf8'));
    expect(settings.provider).toBe('deepseek');
    const secrets = JSON.parse(readFileSync(join(cfgDir, 'secrets.json'), 'utf8'));
    expect(secrets.apiKey).toBe('fake-key-doctor-test-123456');
    expect(settings.apiKey).toBeUndefined(); // key 不进 settings
  });
});
