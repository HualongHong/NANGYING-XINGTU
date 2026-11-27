import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';

const requireModule = createRequire(import.meta.url);
const { packRelease } = requireModule('../scripts/pack-release.mjs') as {
  packRelease: (opts?: { outDir?: string; includeRuntime?: boolean }) => string;
};

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KIMI_NAME = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(@[A-Za-z0-9_-]+)?$/;
const SECRET_RES = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
];
const EXPECTED_SKILLS = 40;
const EXPECTED_RECIPES = 5;

let outDir: string;

function readJson(...segs: string[]) {
  return JSON.parse(readFileSync(join(outDir, ...segs), 'utf8'));
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function skillDirs(...segs: string[]): string[] {
  return readdirSync(join(outDir, ...segs), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function expectValidSkillMd(path: string, namePattern: RegExp) {
  const text = readFileSync(path, 'utf8');
  expect(text.startsWith('---\n'), path).toBe(true);
  const fm = text.slice(0, text.indexOf('\n---\n'));
  const nameMatch = fm.match(/^name: "(.+)"$/m);
  const descMatch = fm.match(/^description: "(.+)"$/m);
  expect(nameMatch, `${path} 缺 frontmatter name`).toBeTruthy();
  expect(descMatch, `${path} 缺 frontmatter description`).toBeTruthy();
  expect(nameMatch![1]).toMatch(namePattern);
  expect(descMatch![1].length).toBeGreaterThan(0);
  // 契约正文保留（技能 ID 段在原 body 中）
  expect(text).toContain('## 技能 ID');
}

beforeAll(() => {
  outDir = packRelease({ outDir: mkdtempSync(join(tmpdir(), 'nangying-release-')), includeRuntime: false });
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('release 打包产物：平台清单符合各平台上架标准', () => {
  it('五平台目录齐备 + release-index 对账', () => {
    for (const p of ['kimiwork', 'qoder', 'dsh', 'workbuddy', 'trae']) {
      expect(existsSync(join(outDir, p)), p).toBe(true);
    }
    const index = readJson('release-index.json');
    expect(Object.keys(index.platforms)).toEqual(['kimiwork', 'qoder', 'dsh', 'workbuddy', 'trae']);
    for (const p of Object.keys(index.platforms)) {
      expect(index.platforms[p].skills).toBe(EXPECTED_SKILLS);
    }
  });

  it('kimiwork：kimi.plugin.json（根）+ name 规则 + skills/commands/mcpServers', () => {
    const m = readJson('kimiwork', 'kimi.plugin.json');
    expect(m.name).toBe('nangying-starmap');
    expect(m.name).toMatch(KIMI_NAME);
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.skills).toBe('./skills');
    expect(m.commands).toBe('./commands');
    expect(m.interface.displayName).toContain('囊萤星图');
    const server = m.mcpServers['nangying-starmap'];
    expect(server.command).toBe('node');
    expect(server.args[0]).toBe('./runtime/server/mcp.js');
    // manifest 不在 .kimi-plugin/ 子目录时也合法，但根清单优先——本包只放根
    expect(existsSync(join(outDir, 'kimiwork', '.kimi-plugin'))).toBe(false);
  });

  it('qoder：.qoder-plugin/plugin.json（不在根）+ kebab name + .mcp.json', () => {
    const m = readJson('qoder', '.qoder-plugin', 'plugin.json');
    expect(m.name).toBe('nangying-starmap');
    expect(m.name).toMatch(KEBAB);
    expect(m.skills).toBe('./skills');
    const mcp = readJson('qoder', '.mcp.json');
    expect(mcp.mcpServers['nangying-starmap'].args[0]).toBe('./runtime/server/mcp.js');
    // Qoder 硬性约定：manifest 不放在插件根
    expect(existsSync(join(outDir, 'qoder', 'plugin.json'))).toBe(false);
  });

  it('dsh：.codex-plugin/plugin.json + preset 交付块', () => {
    const m = readJson('dsh', '.codex-plugin', 'plugin.json');
    expect(m.name).toBe('nangying-starmap');
    expect(m.skills).toBe('./skills');
    const preset = readFileSync(join(outDir, 'dsh', 'preset', 'teaching-assistant.patch.yml'), 'utf8');
    expect(preset).toContain('preset-teaching-assistant');
    expect(preset).toContain('教学助理');
  });

  it('workbuddy：市场两层布局（marketplace.json + plugins/<name>/.codebuddy-plugin/plugin.json）', () => {
    const market = readJson('workbuddy', '.codebuddy-plugin', 'marketplace.json');
    expect(market.name).toBeTruthy();
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0].name).toBe('nangying-starmap');
    expect(market.plugins[0].source).toBe('./plugins/nangying-starmap');
    const m = readJson('workbuddy', 'plugins', 'nangying-starmap', '.codebuddy-plugin', 'plugin.json');
    expect(m.name).toBe('nangying-starmap');
    expect(m.skills).toBe('./skills');
  });

  it('trae：mcp.json + 规则文件 + 技能参考文档（snake 命名与 MCP 工具名一致）', () => {
    const mcp = readJson('trae', 'mcp.json');
    expect(mcp.mcpServers['nangying-starmap'].args[0]).toBe('./runtime/server/mcp.js');
    const rule = readFileSync(join(outDir, 'trae', 'rules', 'nangying-starmap.md'), 'utf8');
    expect(rule).toContain('囊萤星图');
    expect(rule).toContain('mcp__nangying_starmap__');
    const traeSkills = readdirSync(join(outDir, 'trae', 'skills')).filter((f) => f.endsWith('.md'));
    expect(traeSkills).toHaveLength(EXPECTED_SKILLS);
    for (const f of traeSkills) expect(f).toMatch(/^[a-z0-9_]+\.md$/);
  });
});

describe('release 打包产物：技能包（40 = 33 共享 + 7 特化）', () => {
  it('kimiwork 保持 snake 技能名（name 规则允许）', () => {
    const dirs = skillDirs('kimiwork', 'skills');
    expect(dirs).toHaveLength(EXPECTED_SKILLS);
    for (const d of dirs) {
      expect(d).toMatch(/^[a-z0-9_]+$/);
      expectValidSkillMd(join(outDir, 'kimiwork', 'skills', d, 'SKILL.md'), KIMI_NAME);
    }
  });

  it.each([
    ['qoder', ['qoder', 'skills']],
    ['dsh', ['dsh', 'skills']],
    ['workbuddy', ['workbuddy', 'plugins', 'nangying-starmap', 'skills']],
  ])('%s 使用 kebab 技能名（平台硬性/约定要求）', (_label, segs) => {
    const dirs = skillDirs(...(segs as string[]));
    expect(dirs).toHaveLength(EXPECTED_SKILLS);
    for (const d of dirs) {
      expect(d).toMatch(KEBAB);
      expect(d).not.toContain('_');
      expectValidSkillMd(join(outDir, ...(segs as string[]), d, 'SKILL.md'), KEBAB);
    }
  });

  it('kebab 名与 snake 技能 ID 一一对应（无映射丢失）', () => {
    const snakeDirs = skillDirs('kimiwork', 'skills').sort();
    const kebabDirs = skillDirs('dsh', 'skills').sort();
    expect(kebabDirs).toEqual(snakeDirs.map((id) => id.replaceAll('_', '-')).sort());
  });

  it('配方命令 5 个（kimiwork/qoder 共享生成）', () => {
    for (const p of ['kimiwork', 'qoder']) {
      const cmds = readdirSync(join(outDir, p, 'commands')).filter((f) => f.endsWith('.md')).sort();
      expect(cmds).toEqual(['recipe-1.md', 'recipe-2.md', 'recipe-3.md', 'recipe-4.md', 'recipe-5.md']);
      for (const f of cmds) {
        const text = readFileSync(join(outDir, p, 'commands', f), 'utf8');
        expect(text).toContain(`name: "${f.replace('.md', '')}"`);
        expect(text).toMatch(/description: "配方 \d：/);
      }
    }
  });
});

describe('release 打包产物：卫生与完整性', () => {
  it('敏感信息扫描通过（全量文本产物）', () => {
    const offenders: string[] = [];
    for (const file of listFiles(outDir)) {
      if (statSync(file).size > 2 * 1024 * 1024) continue;
      const text = readFileSync(file, 'utf8');
      for (const re of SECRET_RES) {
        if (re.test(text)) offenders.push(relative(outDir, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('每包含 LICENSE，README 含安装指引', () => {
    for (const p of ['kimiwork', 'qoder', 'dsh', 'workbuddy', 'trae']) {
      expect(existsSync(join(outDir, p, 'LICENSE')), `${p}/LICENSE`).toBe(true);
      const readme = readFileSync(join(outDir, p, 'README.md'), 'utf8');
      expect(readme).toContain('安装');
      expect(readme).toContain('nangying-starmap');
    }
  });

  it('SHA256SUMS 与实际文件一一对应', () => {
    const sums = readFileSync(join(outDir, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(sums.length).toBeGreaterThan(0);
    const listed = sums.map((l) => l.split(/\s+/)[1]).sort();
    const actual = listFiles(outDir)
      .map((f) => relative(outDir, f).split('\\').join('/'))
      .filter((f) => f !== 'SHA256SUMS')
      .sort();
    expect(listed).toEqual(actual);
  });

  it('--no-runtime 模式下不含 runtime（正式打包必须含，见 pack:release 冒烟）', () => {
    expect(existsSync(join(outDir, 'kimiwork', 'runtime'))).toBe(false);
  });
});
