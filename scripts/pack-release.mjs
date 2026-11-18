/**
 * 分发打包器：按各目标平台上架标准，从单一事实源（plugin.manifest / skills.meta / skills/**.md）
 * 生成 release/<platform>/ 分发产物。
 *
 * 平台与清单标准（调研基准 2026-11，详见 docs/RELEASE.md）：
 * - kimiwork  Kimi Code 插件：kimi.plugin.json（根），name 允许 snake；skills/<id>/SKILL.md（frontmatter name+description 必填）；commands/；mcpServers（stdio 支持插件根 ./ 路径）
 * - qoder     Qoder CLI 插件：.qoder-plugin/plugin.json（不在根，name kebab 必填）；约定目录 skills/<kebab>/SKILL.md、commands/、.mcp.json
 * - dsh       DeepSeek Harness 插件：git 仓库即插件，.codex-plugin/plugin.json；技能名铁律 [a-z0-9]+(-[a-z0-9]+)*（→ kebab）；附 preset 交付块
 * - workbuddy WorkBuddy 市场：两层布局 .codebuddy-plugin/marketplace.json + plugins/<name>/.codebuddy-plugin/plugin.json；skills kebab
 * - trae      TRAE 暂无原生插件包标准（社区功能请求中）：MCP（mcp.json）+ 规则文档分发
 *
 * 共享组件：技能 SKILL.md 生成（frontmatter + 契约正文）、kebab 命名映射、runtime（dist 拷贝）、
 * 五配方 commands、敏感信息扫描、SHA256SUMS。
 *
 * 用法：node scripts/pack-release.mjs [--out <dir>] [--no-runtime]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/HualongHong/NANGYING-XINGTU';

const SECRET_PATTERNS = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, label: '私钥块' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key ID' },
  { re: /\bsk-[A-Za-z0-9]{16,}\b/, label: 'API key（sk- 前缀）' },
  { re: /\b(?:api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}["']?/i, label: '硬编码凭证字段' },
];

function yamlStr(s) {
  return JSON.stringify(String(s)); // JSON 双引号串是合法 YAML 标量
}

function frontmatter(fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${yamlStr(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function kebab(id) {
  return id.replaceAll('_', '-');
}

function loadSources() {
  const manifest = JSON.parse(readFileSync(join(root, 'manifests/plugin.manifest.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(root, 'manifests/skills.meta.json'), 'utf8')).skills;
  // 顺序以 plugin.manifest 为准（共享 → 特化），与注册表/文档一致
  const orderedIds = [...manifest.skills.shared, ...manifest.skills.specialized];
  const skills = orderedIds.map((id) => {
    const m = meta[id];
    if (!m) throw new Error(`skills.meta.json 缺少技能：${id}`);
    const body = readFileSync(join(root, m.docPath), 'utf8');
    return { id, kebab: kebab(id), type: m.type, cname: m.name, description: m.description, body };
  });
  return { manifest, skills };
}

/** 技能目录生成：nameStyle = 'snake' | 'kebab'，目录名与 frontmatter name 一致 */
function writeSkills(dir, skills, nameStyle) {
  for (const s of skills) {
    const name = nameStyle === 'kebab' ? s.kebab : s.id;
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    const doc = frontmatter({ name, description: s.description }) + s.body;
    writeFileSync(join(skillDir, 'SKILL.md'), doc);
  }
}

function parseRecipes() {
  const md = readFileSync(join(root, 'docs/RECIPES.md'), 'utf8');
  const re = /^## 配方 (\d+)：(.+)$/gm;
  const hits = [];
  let m;
  while ((m = re.exec(md)) !== null) hits.push({ index: m.index, n: m[1], title: m[2].trim() });
  return hits.map((h, i) => {
    const start = md.indexOf('\n', h.index) + 1;
    const end = i + 1 < hits.length ? hits[i + 1].index : md.length;
    return { n: h.n, title: h.title, body: md.slice(start, end).trim() };
  });
}

function writeRecipeCommands(dir, recipes) {
  mkdirSync(dir, { recursive: true });
  for (const r of recipes) {
    const doc = frontmatter({ name: `recipe-${r.n}`, description: `配方 ${r.n}：${r.title}` }) +
      `按以下配方执行（囊萤星图技能链，详见包内 skills/ 与仓库 docs/RECIPES.md）：\n\n${r.body}\n`;
    writeFileSync(join(dir, `recipe-${r.n}.md`), doc);
  }
}

function copyRuntime(dest, includeRuntime) {
  if (!includeRuntime) return;
  const dist = join(root, 'dist');
  if (!existsSync(join(dist, 'server/mcp.js'))) {
    throw new Error('dist/ 缺失或未构建：请先 pnpm run build');
  }
  cpSync(dist, join(dest, 'runtime'), { recursive: true });
}

function copyLicense(dest) {
  cpSync(join(root, 'LICENSE'), join(dest, 'LICENSE'));
}

function mappingTable(skills) {
  const rows = skills.map((s) => `| \`${s.id}\` | \`${s.kebab}\` | ${s.cname} |`);
  return ['| MCP 工具名（snake） | 技能名（kebab） | 中文名 |', '| --- | --- | --- |', ...rows].join('\n');
}

function scanSecrets(outDir) {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (st.size > 2 * 1024 * 1024) continue; // 大二进制不扫（runtime 内无文本密钥源）
      const text = readFileSync(p, 'utf8');
      for (const { re, label } of SECRET_PATTERNS) {
        if (re.test(text)) offenders.push(`${relative(outDir, p)} ← ${label}`);
      }
    }
  };
  walk(outDir);
  if (offenders.length > 0) {
    throw new Error(`分发产物疑似包含敏感信息，已中止：\n${offenders.join('\n')}`);
  }
}

function writeSums(outDir) {
  const lines = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      const hash = createHash('sha256').update(readFileSync(p)).digest('hex');
      lines.push(`${hash}  ${relative(outDir, p).split('\\').join('/')}`);
    }
  };
  walk(outDir);
  writeFileSync(join(outDir, 'SHA256SUMS'), lines.join('\n') + '\n');
}

const COMMON_NOTES = [
  '## 能力一览',
  '',
  '- 共享技能 31 个：材料解析 → 知识图谱 → 课程结构 → 讲稿 → 多语翻译 → 课程包/答疑库/学习路径 → 审计与导出全链路',
  '- 特化技能 7 个：数字分身/视频/语音/多师协同/实时问答（默认降级实现，交付中间态，绝不假装出片）',
  '- 按需技能：settings_card（API key 配置）、submit_feedback（回馈协调，默认脱敏 + 审阅门）、inspect_teaching_dataset（OpenDataLab）、enrich_knowledge_evidence（SciVerse）',
  '',
  '## 降级政策',
  '',
  '每个技能的「降级策略」是承诺不是弱点：外部引擎不可用时明确标注降级结果，主流程不中断。',
  '',
  '## 隐私',
  '',
  '无遥测、无上报；回馈内容默认去除敏感信息并经用户审阅后才存储。',
  '',
  `## 许可与仓库`,
  '',
  `Apache-2.0；源码与文档：${REPO_URL}`,
].join('\n');

function emitKimiwork(out, { manifest, skills }, includeRuntime) {
  const dir = join(out, 'kimiwork');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'kimi.plugin.json'), JSON.stringify({
    name: 'nangying-starmap',
    version: manifest.version,
    description: manifest.description,
    keywords: ['education', 'knowledge-graph', 'mooc', 'courseware', 'multilingual'],
    author: { name: 'Hualong Hong' },
    homepage: REPO_URL,
    license: 'Apache-2.0',
    interface: {
      displayName: '囊萤星图 Nangying StarMap',
      shortDescription: manifest.slogan,
    },
    skills: './skills',
    commands: './commands',
    mcpServers: {
      'nangying-starmap': { command: 'node', args: ['./runtime/server/mcp.js'] },
    },
  }, null, 2) + '\n');
  writeSkills(join(dir, 'skills'), skills, 'snake');
  writeRecipeCommands(join(dir, 'commands'), parseRecipes());
  copyRuntime(dir, includeRuntime);
  copyLicense(dir);
  writeFileSync(join(dir, 'README.md'), [
    '# 囊萤星图（Kimi Code / KimiWORK 插件包）',
    '',
    '## 安装',
    '',
    '方式一（GitHub 直达）：`/plugins install https://github.com/HualongHong/NANGYING-XINGTU`',
    '',
    '方式二（本地目录）：`/plugins install <本目录>`',
    '',
    '安装后 `/reload` 或开新会话生效。技能以 `nangying-starmap:<技能名>` 命名空间调用；五个配方注册为 `/nangying-starmap:recipe-1` ~ `recipe-5` 命令。',
    '',
    '## MCP runtime',
    '',
    '插件声明了 stdio MCP server（`runtime/server/mcp.js`，38 个 `mcp__nangying_starmap__*` 工具）。需要本机 Node ≥ 20；可在 `/plugins` 面板对该 server 单独启停。',
    '',
    COMMON_NOTES,
    '',
  ].join('\n'));
}

function emitQoder(out, { manifest, skills }, includeRuntime) {
  const dir = join(out, 'qoder');
  mkdirSync(join(dir, '.qoder-plugin'), { recursive: true });
  writeFileSync(join(dir, '.qoder-plugin', 'plugin.json'), JSON.stringify({
    name: 'nangying-starmap',
    version: manifest.version,
    displayName: '囊萤星图 Nangying StarMap',
    description: manifest.slogan + manifest.description,
    author: { name: 'Hualong Hong', url: REPO_URL },
    homepage: REPO_URL,
    repository: REPO_URL,
    license: 'Apache-2.0',
    keywords: ['education', 'knowledge-graph', 'mooc', 'courseware', 'multilingual'],
    skills: './skills',
    commands: './commands',
    mcpServers: './.mcp.json',
  }, null, 2) + '\n');
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'nangying-starmap': { command: 'node', args: ['./runtime/server/mcp.js'] },
    },
  }, null, 2) + '\n');
  writeSkills(join(dir, 'skills'), skills, 'kebab');
  writeRecipeCommands(join(dir, 'commands'), parseRecipes());
  copyRuntime(dir, includeRuntime);
  copyLicense(dir);
  writeFileSync(join(dir, 'README.md'), [
    '# 囊萤星图（Qoder 插件包）',
    '',
    '## 安装',
    '',
    '本地目录安装：`qodercn plugins install <本目录>`；安装前可 `qodercn plugins validate <本目录>` 预检。',
    '',
    '市场安装：把本包（或含本包的 git 仓库）加入 marketplace 后以 `nangying-starmap` 安装。',
    '',
    '注意：Qoder 约定技能名为 kebab-case，与 MCP 工具名（snake）不同，映射如下：',
    '',
    mappingTable(skills),
    '',
    COMMON_NOTES,
    '',
  ].join('\n'));
}

function emitDsh(out, { manifest, skills }) {
  const dir = join(out, 'dsh');
  mkdirSync(join(dir, '.codex-plugin'), { recursive: true });
  writeFileSync(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'nangying-starmap',
    version: manifest.version,
    description: manifest.slogan + manifest.description,
    skills: './skills',
  }, null, 2) + '\n');
  writeSkills(join(dir, 'skills'), skills, 'kebab');
  // preset 交付块：随包附带，install-dsh.mjs --with-preset 同源
  mkdirSync(join(dir, 'preset'), { recursive: true });
  cpSync(join(root, 'dsh/preset-teaching-assistant.patch.yml'), join(dir, 'preset', 'teaching-assistant.patch.yml'));
  copyLicense(dir);
  writeFileSync(join(dir, 'README.md'), [
    '# 囊萤星图（DSH / DeepSeek Harness 插件包）',
    '',
    '## 安装',
    '',
    `git 仓库即插件：\`dsh plugin --profile web add github:HualongHong/NANGYING-XINGTU\`（或本地路径），安装后重启 \`dsh web\`。`,
    '',
    '插件名：`nangying-starmap`（市场插件 id，与 preset persona 驱动的 MCP server 同名）。',
    '',
    '## preset（教学助理）',
    '',
    '`preset/teaching-assistant.patch.yml` 为可选交付块：把其中 YAML 段幂等追加进 DSH profile 的 `cordis.patch.yml`（与仓库 `scripts/install-dsh.mjs --with-preset` 同源），重启后在 DSH 界面手动选用「教学助理」preset，即获得按五个配方驱动 38 个 MCP 技能的 persona。',
    '',
    '## 技能命名',
    '',
    'DSH 技能名铁律为小写 kebab-case，与 MCP 工具名（snake）不同，映射如下：',
    '',
    mappingTable(skills),
    '',
    COMMON_NOTES,
    '',
  ].join('\n'));
}

function emitWorkbuddy(out, { manifest, skills }) {
  const dir = join(out, 'workbuddy');
  const plug = join(dir, 'plugins', 'nangying-starmap');
  mkdirSync(join(dir, '.codebuddy-plugin'), { recursive: true });
  writeFileSync(join(dir, '.codebuddy-plugin', 'marketplace.json'), JSON.stringify({
    name: 'nangying',
    owner: { name: 'Hualong Hong', url: REPO_URL },
    plugins: [{
      name: 'nangying-starmap',
      source: './plugins/nangying-starmap',
      category: 'education',
      tags: ['knowledge-graph', 'mooc', 'courseware', 'multilingual', 'teaching'],
    }],
  }, null, 2) + '\n');
  mkdirSync(join(plug, '.codebuddy-plugin'), { recursive: true });
  writeFileSync(join(plug, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({
    name: 'nangying-starmap',
    version: manifest.version,
    description: manifest.slogan + manifest.description,
    skills: './skills',
  }, null, 2) + '\n');
  writeSkills(join(plug, 'skills'), skills, 'kebab');
  copyLicense(dir);
  writeFileSync(join(dir, 'README.md'), [
    '# 囊萤星图（WorkBuddy 市场包）',
    '',
    '标准两层布局：仓根 `.codebuddy-plugin/marketplace.json` 是市场清单，插件本体在 `plugins/nangying-starmap/`。',
    '',
    '## 安装',
    '',
    '```',
    'codebuddy plugin marketplace add <本目录> --name nangying',
    'codebuddy plugin install nangying-starmap@nangying',
    '```',
    '',
    '安装后完全退出并重启 WorkBuddy，新会话生效。可在插件页对 skill 组件逐项开关。',
    '',
    '技能名 kebab-case 与 MCP 工具名（snake）映射：',
    '',
    mappingTable(skills),
    '',
    COMMON_NOTES,
    '',
  ].join('\n'));
}

function emitTrae(out, { manifest, skills }, includeRuntime) {
  const dir = join(out, 'trae');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      'nangying-starmap': { command: 'node', args: ['./runtime/server/mcp.js'] },
    },
  }, null, 2) + '\n');
  // TRAE 无原生技能标准：规则文件（自动进上下文）+ 技能参考文档（按需读取）
  mkdirSync(join(dir, 'rules'), { recursive: true });
  const list = skills.map((s) => `- \`${s.id}\`（${s.type === 'specialized' ? '特化·默认降级' : '共享'}）：${s.description}`).join('\n');
  writeFileSync(join(dir, 'rules', 'nangying-starmap.md'), [
    '# 囊萤星图能力规则',
    '',
    `本工作区已接入囊萤星图 MCP server（${manifest.slogan}${manifest.description}）。`,
    '教学任务优先调用 MCP 工具（mcp__nangying_starmap__*）；五个典型工作流（配方）见包内 skills 目录或仓库 docs/RECIPES.md。',
    '特化技能默认降级：无外部引擎时交付制作清单等中间态，必须明确告知用户降级事实。',
    '',
    '## 技能清单（38）',
    '',
    list,
    '',
  ].join('\n'));
  mkdirSync(join(dir, 'skills'), { recursive: true });
  for (const s of skills) {
    writeFileSync(join(dir, 'skills', `${s.id}.md`), s.body);
  }
  copyRuntime(dir, includeRuntime);
  copyLicense(dir);
  writeFileSync(join(dir, 'README.md'), [
    '# 囊萤星图（TRAE 分发包）',
    '',
    '> TRAE 目前无原生插件包标准（官方社区功能请求中），本包按 TRAE 现行能力以 **MCP + 规则** 方式分发。',
    '',
    '## 安装',
    '',
    '1. MCP：TRAE 设置 → MCP → 添加 stdio server，命令 `node <本目录>/runtime/server/mcp.js`（或把 `mcp.json` 内容并入项目 MCP 配置）。',
    '2. 规则：把 `rules/nangying-starmap.md` 复制到项目 `.trae/rules/` 目录。',
    '3. `skills/` 为 38 个技能的参考文档（保持 snake 命名，与 MCP 工具名一致），agent 按需读取。',
    '',
    '需要本机 Node ≥ 20。MCP 工具名为 `mcp__nangying_starmap__*`（38 个）。',
    '',
    COMMON_NOTES,
    '',
  ].join('\n'));
}

export function packRelease({ outDir = join(root, 'release'), includeRuntime = true } = {}) {
  const sources = loadSources();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  emitKimiwork(outDir, sources, includeRuntime);
  emitQoder(outDir, sources, includeRuntime);
  emitDsh(outDir, sources);
  emitWorkbuddy(outDir, sources);
  emitTrae(outDir, sources, includeRuntime);
  scanSecrets(outDir);
  writeFileSync(join(outDir, 'release-index.json'), JSON.stringify({
    id: sources.manifest.id,
    version: sources.manifest.version,
    generatedAt: new Date().toISOString(),
    repository: REPO_URL,
    platforms: {
      kimiwork: { manifest: 'kimi.plugin.json', skills: sources.skills.length, commands: parseRecipes().length },
      qoder: { manifest: '.qoder-plugin/plugin.json', skills: sources.skills.length, commands: parseRecipes().length },
      dsh: { manifest: '.codex-plugin/plugin.json', skills: sources.skills.length, preset: 'preset/teaching-assistant.patch.yml' },
      workbuddy: { manifest: 'plugins/nangying-starmap/.codebuddy-plugin/plugin.json', skills: sources.skills.length },
      trae: { mcp: 'mcp.json', skills: sources.skills.length },
    },
  }, null, 2) + '\n');
  writeSums(outDir);
  return outDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : join(root, 'release');
  const includeRuntime = !args.includes('--no-runtime');
  const dest = packRelease({ outDir, includeRuntime });
  console.log(`分发产物已生成：${dest}`);
  console.log('平台：kimiwork / qoder / dsh / workbuddy / trae（敏感信息扫描通过，SHA256SUMS 已写出）');
}
