/**
 * DSH Desktop 对话式安装脚本（零依赖）。
 *
 * 用法（由 DSH agent 在对话中执行，或用户手动）：
 *   node scripts/install-dsh.mjs            # 安装/幂等更新 MCP 注册
 *   node scripts/install-dsh.mjs --check    # 只检查不写入
 *   node scripts/install-dsh.mjs --uninstall  # 移除注册（先备份）
 *
 * 行为：
 *   - 前置：Node ≥20；dist/server/mcp.js 缺失时自动 pnpm install + build；
 *   - 定位 DSH profile（默认 ~/.dsh/profiles/desktop，env DSH_PROFILE_DIR 覆盖）；
 *   - 幂等：已注册则更新 command/args 绝对路径，未注册则备份后追加顶层 - insert 块；
 *   - YAML 用保守文本操作（文件含注释与 !!js 表达式，不经 YAML 解析器重写）。
 *
 * 导出的纯函数（splitTopLevelBlocks/install/uninstall/checkStatus）供单测锁定幂等性。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, realpathSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MCP_ID = 'mcp-nangying-starmap';
export const SERVER_NAME = 'nangying_starmap';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = join(pluginRoot, 'dist', 'server', 'mcp.js');

// ---------- YAML 顶层块的保守文本操作 ----------

/** 把 patch 文件文本切成顶层块：返回 [{ start, end, text }]（含边界行，end 为开区间） */
export function splitTopLevelBlocks(text) {
  const lines = text.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === '---' || (l.startsWith('- ') && !l.startsWith('  '))) {
      starts.push(i);
    }
  }
  const blocks = [];
  for (let i = 0; i < starts.length; i++) {
    blocks.push({ start: starts[i], end: i + 1 < starts.length ? starts[i + 1] : lines.length });
  }
  return { lines, blocks };
}

export function findMcpBlock(text, id = MCP_ID) {
  const { lines, blocks } = splitTopLevelBlocks(text);
  for (const b of blocks) {
    const body = lines.slice(b.start, b.end).join('\n');
    if (body.includes(`id: ${id}`)) return b;
  }
  return null;
}

/** 生成注册块文本（command/args 用绝对路径） */
export function buildInsertBlock(nodePath, entryPath) {
  const q = (p) => `'${p.replace(/\\/g, '\\\\')}'`;
  return [
    '- insert:',
    `    - id: ${MCP_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${SERVER_NAME}`,
    "        transport: stdio",
    `        command: ${q(nodePath)}`,
    `        args: [ ${q(entryPath)} ]`,
    '        toolCallTimeoutMs: 900000',
    '        failOnStartupError: false',
    '        reconnect:',
    '          enabled: true',
    '',
  ].join('\n');
}

/** 更新已有块内的 command/args 行（保留其余内容） */
function updateBlock(text, block, nodePath, entryPath) {
  const { lines } = splitTopLevelBlocks(text);
  const q = (p) => `'${p.replace(/\\/g, '\\\\')}'`;
  for (let i = block.start; i < block.end; i++) {
    const t = lines[i].trim();
    if (t.startsWith('command:')) lines[i] = lines[i].replace(/command:.*/, `command: ${q(nodePath)}`);
    if (t.startsWith('args:')) lines[i] = lines[i].replace(/args:.*/, `args: [ ${q(entryPath)} ]`);
  }
  return lines.join('\n');
}

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${file}.bak-${stamp}`;
  copyFileSync(file, bak);
  return bak;
}

// ---------- 对外操作 ----------

export function defaultProfileDir() {
  return process.env.DSH_PROFILE_DIR
    ? resolve(process.env.DSH_PROFILE_DIR)
    : join(homedir(), '.dsh', 'profiles', 'desktop');
}

/**
 * 注册块自检（保守文本解析，不经 YAML 解析器）：验证 mcp 注册块字段齐全与类型。
 * 返回问题列表（空数组 = 合规），每条含字段、问题与修复建议。
 */
export function validateBlock(text, id = MCP_ID) {
  const block = findMcpBlock(text, id);
  if (!block) return [{ field: 'id', issue: `未找到 ${id} 注册块`, fix: '运行 install 脚本完成注册' }];
  const { lines } = splitTopLevelBlocks(text);
  const body = lines.slice(block.start, block.end);
  const get = (key) => {
    for (const ln of body) {
      const m = new RegExp(`^\\s+${key}:\\s*(.*)$`).exec(ln);
      if (m) return m[1].trim();
    }
    return undefined;
  };
  const issues = [];
  const serverName = get('serverName')?.replace(/^['"]|['"]$/g, '') ?? '';
  if (!serverName) issues.push({ field: 'serverName', issue: '缺失或为空', fix: 'config.serverName 填非空字符串（如 nangying_starmap）' });
  else if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    issues.push({ field: 'serverName', issue: `值 "${serverName}" 不符合 [A-Za-z0-9_-]{1,32}`, fix: '改用字母/数字/下划线/连字符组合' });
  }
  const transport = get('transport')?.replace(/^['"]|['"]$/g, '') ?? '';
  if (!['stdio', 'streamable-http'].includes(transport)) {
    issues.push({ field: 'transport', issue: `值 "${transport}" 非法`, fix: 'transport 应为 stdio 或 streamable-http' });
  }
  const command = get('command')?.replace(/^['"]|['"]$/g, '') ?? '';
  const argsRaw = get('args');
  if (transport === 'stdio') {
    if (!command) issues.push({ field: 'command', issue: 'stdio 传输缺少 command', fix: 'command 填 node 绝对路径' });
    if (argsRaw === undefined) {
      issues.push({ field: 'args', issue: 'stdio 传输缺少 args', fix: "args 填行内数组，如 args: [ '<插件根>/dist/server/mcp.js' ]" });
    } else if (!/^\[.*\]$/.test(argsRaw)) {
      issues.push({ field: 'args', issue: 'args 不是行内数组', fix: '改为行内数组写法（多行列表暂不受自检支持）' });
    }
  }
  const timeoutRaw = get('toolCallTimeoutMs');
  if (timeoutRaw === undefined) {
    issues.push({ field: 'toolCallTimeoutMs', issue: '缺失', fix: '填正整数（建议 900000）' });
  } else if (!/^\d+$/.test(timeoutRaw) || Number(timeoutRaw) <= 0) {
    issues.push({ field: 'toolCallTimeoutMs', issue: `值 "${timeoutRaw}" 不是正整数`, fix: '填正整数（毫秒）' });
  }
  if (!body.some((ln) => /^\s+reconnect:/.test(ln))) {
    issues.push({ field: 'reconnect', issue: '缺少 reconnect 块', fix: '添加 reconnect: { enabled: true } 以支持断线重连' });
  }
  return issues;
}

/** 从注册块提取 args 中的入口路径（行内数组首元素），未注册/无法解析返回 null */
export function extractEntryPath(text, id = MCP_ID) {
  const block = findMcpBlock(text, id);
  if (!block) return null;
  const { lines } = splitTopLevelBlocks(text);
  for (const ln of lines.slice(block.start, block.end)) {
    const m = /^\s+args:\s*\[\s*'([^']+)'\s*\]/.exec(ln);
    if (m) return m[1].replace(/\\\\/g, '\\');
  }
  return null;
}

export function checkStatus(profileDir = defaultProfileDir()) {
  const file = join(profileDir, 'cordis.patch.yml');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const registered = existsSync(file) && findMcpBlock(text) !== null;
  const entryPath = registered ? extractEntryPath(text) : null;
  const currentEntry = existsSync(distEntry) ? realpathSync(distEntry) : distEntry;
  return {
    profileDir,
    patchFile: file,
    profileExists: existsSync(file),
    registered,
    blockIssues: registered ? validateBlock(text) : [],
    entryPath,
    pathMatchesPluginRoot: entryPath !== null && existsSync(entryPath)
      ? realpathSync(entryPath) === currentEntry
      : entryPath === null ? null : false,
    distReady: existsSync(distEntry),
    distEntry: currentEntry,
  };
}

export function install(profileDir = defaultProfileDir(), opts = {}) {
  const file = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(file)) {
    throw new Error(`未找到 DSH profile 补丁文件：${file}（可用 env DSH_PROFILE_DIR 指定目录）`);
  }
  const nodePath = opts.nodePath ?? process.execPath;
  const entryPath = opts.entryPath ?? distEntry;
  const text = readFileSync(file, 'utf8');
  const block = findMcpBlock(text);
  if (block) {
    const next = updateBlock(text, block, nodePath, entryPath);
    if (next !== text) {
      backup(file);
      writeFileSync(file, next, 'utf8');
      return { action: 'updated', file };
    }
    return { action: 'unchanged', file };
  }
  const bak = backup(file);
  const sep = text.endsWith('\n') ? '' : '\n';
  writeFileSync(file, `${text}${sep}${buildInsertBlock(nodePath, entryPath)}`, 'utf8');
  return { action: 'installed', file, backup: bak };
}

export function uninstall(profileDir = defaultProfileDir()) {
  const file = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(file)) return { action: 'absent', file };
  const text = readFileSync(file, 'utf8');
  const block = findMcpBlock(text);
  if (!block) return { action: 'absent', file };
  backup(file);
  const { lines } = splitTopLevelBlocks(text);
  lines.splice(block.start, block.end - block.start);
  // 清理可能残留的多余空行
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  writeFileSync(file, out, 'utf8');
  return { action: 'removed', file };
}

// ---------- 前置与主入口 ----------

function ensureBuild() {
  if (existsSync(distEntry)) return;
  console.log('未找到 MCP 产物，开始安装依赖并构建…');
  let pnpm = spawnSync('pnpm', ['--version'], { shell: true, encoding: 'utf8' });
  if (pnpm.status !== 0) {
    console.log('未检测到 pnpm，尝试 corepack enable …');
    const cp = spawnSync('corepack', ['enable'], { shell: true, stdio: 'inherit' });
    if (cp.status !== 0) {
      throw new Error('无法启用 pnpm：请手动安装 Node ≥20 并启用 corepack，然后重试');
    }
    pnpm = spawnSync('pnpm', ['--version'], { shell: true, encoding: 'utf8' });
    if (pnpm.status !== 0) throw new Error('corepack 启用后仍无 pnpm，请手动安装');
  }
  console.log('pnpm install …');
  const inst = spawnSync('pnpm', ['install'], { shell: true, stdio: 'inherit', cwd: pluginRoot });
  if (inst.status !== 0) throw new Error('依赖安装失败（pnpm install 非零退出）');
  console.log('pnpm run build …');
  const build = spawnSync('pnpm', ['run', 'build'], { shell: true, stdio: 'inherit', cwd: pluginRoot });
  if (build.status !== 0) throw new Error('构建失败（pnpm run build 非零退出），请查看上方错误');
  console.log('构建完成。');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

/** 递归收集目录下最新 mtime（.ts/.mts/.json） */
function latestMtime(dir, ext, since = 0) {
  if (!existsSync(dir)) return since;
  let max = since;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === 'node_modules' || name.name.startsWith('.')) continue;
      max = latestMtime(p, ext, max);
    } else if (ext.some((e) => name.name.endsWith(e))) {
      const m = readFileSync(p).length >= 0 ? (statSync(p).mtimeMs) : 0;
      if (m > max) max = m;
    }
  }
  return max;
}

/**
 * 环境医生：全项扫描（只读）。status: ok / warn（需人工） / fail。
 * 返回 { items, autoFixable }；--fix 后由 fixDoctorIssues 执行安全修复。
 */
export function runDoctor(opts = {}) {
  const root = opts.pluginRoot ?? pluginRoot;
  const dist = opts.distEntry ?? distEntry;
  const profileDir = opts.profileDir ?? defaultProfileDir();
  const items = [];
  const push = (id, label, status, detail, autoFixable = false) =>
    items.push({ id, label, status, detail, autoFixable });

  // 环境
  const major = Number(process.versions.node.split('.')[0]);
  push('node', 'Node ≥20', major >= 20 ? 'ok' : 'fail', `当前 v${process.versions.node}`);
  const pnpm = spawnSync('pnpm', ['--version'], { shell: true, encoding: 'utf8' });
  push('pnpm', 'pnpm 可用', pnpm.status === 0 ? 'ok' : 'warn',
    pnpm.status === 0 ? `v${pnpm.stdout.trim()}` : '未检测到，可运行 corepack enable');

  // 产物与新鲜度
  const distReady = existsSync(dist);
  push('dist', 'MCP 产物存在', distReady ? 'ok' : 'fail', dist);
  if (distReady) {
    const srcDirs = ['core', 'adapters', 'server', 'cli'].map((d) => join(root, d));
    const srcNewest = Math.max(...srcDirs.map((d) => latestMtime(d, ['.ts', '.mts'])));
    const stale = statSync(dist).mtimeMs < srcNewest;
    push('dist-fresh', '产物新鲜度（dist 不旧于源码）', stale ? 'warn' : 'ok',
      stale ? '源码有新改动，dist 已过期' : 'dist 新于源码',
      stale); // 可自动修复：pnpm run build
  }

  // 注册四项
  const s = checkStatus(profileDir);
  push('dsh-profile', 'DSH profile 可探测', s.profileExists ? 'ok' : 'warn',
    s.profileExists ? s.patchFile : '未找到 cordis.patch.yml（可 env DSH_PROFILE_DIR 指定）');
  push('registered', 'MCP 已注册', s.registered ? 'ok' : 'warn', `id: ${MCP_ID}`);
  if (s.registered) {
    push('path-match', '路径匹配（注册 args = 当前插件根）',
      s.pathMatchesPluginRoot === false ? 'warn' : s.pathMatchesPluginRoot ? 'ok' : 'warn',
      s.pathMatchesPluginRoot === false ? '仓库已移动，需重新注册' : s.pathMatchesPluginRoot ? '一致' : '无法解析注册路径',
      s.pathMatchesPluginRoot === false); // 可自动修复：install()
    push('block-valid', '注册块自检', s.blockIssues.length === 0 ? 'ok' : 'warn',
      s.blockIssues.length === 0 ? '通过' : `${s.blockIssues.length} 个问题（见 --check 详情）`);
  }

  // OCR 语言包缓存
  const cacheCandidates = [
    join(root, 'node_modules', '.tesseract.js-cache'),
    join(root, 'tessdata'),
    join(root), // 仓库根直接放置的 chi_sim.traineddata
    join(process.cwd(), 'node_modules', '.tesseract.js-cache'),
  ];
  const ocrFound = cacheCandidates.filter((d) =>
    existsSync(d) && readdirSync(d).some((f) => /chi_sim.*traineddata|chi_sim/.test(f)));
  push('ocr-cache', 'OCR 语言包（chi_sim）缓存',
    ocrFound.length > 0 ? 'ok' : 'warn',
    ocrFound.length > 0 ? `已缓存：${ocrFound[0]}` : '未缓存（可 --prewarm-ocr 预热，需联网）');

  // LLM 配置状态（全脱敏：只报来源与 key 是否解析得到）
  const envFile = join(root, '.env');
  const llmLines = [];
  if (existsSync(envFile)) {
    for (const ln of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^(MINIMAX_API_KEY|DEEPSEEK_API_KEY|MOONSHOT_API_KEY)=(.+)$/.exec(ln.trim());
      if (m && m[2].trim()) {
        llmLines.push(`${m[1] === 'DEEPSEEK_API_KEY' ? 'DeepSeek' : m[1] === 'MINIMAX_API_KEY' ? 'MiniMax' : 'Moonshot'}（.env 调试）：key 已配置`);
      }
    }
  }
  try {
    const cfgFile = join(configDirForDoctor(), 'settings.json');
    if (existsSync(cfgFile)) {
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
      const secFile = join(configDirForDoctor(), 'secrets.json');
      const hasKey = existsSync(secFile) && Boolean(JSON.parse(readFileSync(secFile, 'utf8')).apiKey);
      llmLines.push(`${cfg.provider ?? 'unknown'}（settings/secrets 正式路径）：key ${hasKey ? '已配置' : '未配置'}`);
    }
  } catch { /* 配置目录不可读时略过 */ }
  push('llm', 'LLM 配置（脱敏）', llmLines.length > 0 ? 'ok' : 'warn',
    llmLines.length > 0 ? llmLines.join('；') : '未配置（可选：--setup-llm，或宿主注入）');

  const autoFixable = items.filter((i) => i.autoFixable && i.status !== 'ok');
  return { items, autoFixable };
}

function configDirForDoctor() {
  return process.env.NANGYING_CONFIG_DIR ?? join(homedir(), '.nangying-starmap');
}

/** 执行安全修复（dist 过期重建、路径不一致重新注册），返回修复清单 */
export function fixDoctorIssues(opts = {}) {
  const fixed = [];
  const d = runDoctor(opts);
  for (const item of d.autoFixable) {
    if (item.id === 'dist-fresh') {
      const build = spawnSync('pnpm', ['run', 'build'], { shell: true, stdio: 'inherit', cwd: opts.pluginRoot ?? pluginRoot });
      if (build.status === 0) fixed.push('dist 过期：已重新构建（pnpm run build）');
    }
    if (item.id === 'path-match') {
      const r = install(opts.profileDir ?? defaultProfileDir());
      if (r.action === 'updated' || r.action === 'installed') fixed.push('路径不一致：已重新注册 MCP');
    }
  }
  return fixed;
}

/** --with-llm：注册块 config 内幂等注入 env.NANGYING_MCP_LLM（server 通道 LLM 开关） */
export function enableServerLlm(profileDir = defaultProfileDir()) {
  const file = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(file)) throw new Error(`未找到 DSH profile 补丁文件：${file}`);
  const text = readFileSync(file, 'utf8');
  const block = findMcpBlock(text);
  if (!block) return { action: 'absent', file, note: 'MCP 未注册，先运行 install' };
  const { lines } = splitTopLevelBlocks(text);
  const body = lines.slice(block.start, block.end).join(String.fromCharCode(10));
  if (body.includes('NANGYING_MCP_LLM')) {
    return { action: 'skipped', file, note: 'LLM 开关已存在' };
  }
  // 在 reconnect: 行前插入 env 块（保守文本操作）
  let inserted = false;
  for (let i = block.start; i < block.end; i++) {
    if (/^\s+reconnect:/.test(lines[i])) {
      lines.splice(i, 0, "        env:", "          NANGYING_MCP_LLM: '1'");
      inserted = true;
      break;
    }
  }
  if (!inserted) lines.splice(block.end, 0, "        env:", "          NANGYING_MCP_LLM: '1'");
  backup(file);
  writeFileSync(file, lines.join(String.fromCharCode(10)), 'utf8');
  return { action: 'enabled', file };
}

export function serverLlmStatus(profileDir = defaultProfileDir()) {
  const file = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(file)) return 'unknown';
  const block = findMcpBlock(readFileSync(file, 'utf8'));
  if (!block) return 'absent';
  const { lines } = splitTopLevelBlocks(readFileSync(file, 'utf8'));
  return lines.slice(block.start, block.end).join(String.fromCharCode(10)).includes('NANGYING_MCP_LLM:')
    ? 'enabled'
    : 'disabled';
}

/** --with-preset：把仓库 dsh/preset-teaching-assistant.patch.yml 的 - insert 块幂等追加 */
export function installPreset(profileDir = defaultProfileDir(), opts = {}) {
  const srcFile = join(opts.pluginRoot ?? pluginRoot, 'dsh', 'preset-teaching-assistant.patch.yml');
  const file = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(srcFile)) throw new Error(`未找到 preset 交付文件：${srcFile}`);
  if (!existsSync(file)) throw new Error(`未找到 DSH profile 补丁文件：${file}`);
  const target = readFileSync(file, 'utf8');
  if (target.includes('id: preset-teaching-assistant')) {
    return { action: 'skipped', file, note: 'preset 已注册，跳过' };
  }
  const srcLines = readFileSync(srcFile, 'utf8').split('\n');
  const start = srcLines.findIndex((l) => l.startsWith('- insert:'));
  if (start < 0) throw new Error('preset 交付文件中未找到 - insert 块');
  const block = srcLines.slice(start).join('\n').replace(/\s+$/, '') + '\n';
  backup(file);
  const sep = target.endsWith('\n') ? '' : '\n';
  writeFileSync(file, `${target}${sep}${block}`, 'utf8');
  return { action: 'installed', file };
}

/** 参数模式 --setup-llm：写正式配置路径（settings 644 / secrets 600），复用 dist configStore */
export async function setupLlmParam(opts) {
  const { provider, apiKeyEnv } = opts;
  const PROVIDERS = {
    deepseek: { endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY' },
    minimax: { endpoint: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3', env: 'MINIMAX_API_KEY' },
  };
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`未知 provider：${provider}（可选 ${Object.keys(PROVIDERS).join('/')}，或交互模式选自定义）`);
  let apiKey;
  let note = '';
  if (apiKeyEnv) {
    apiKey = process.env[apiKeyEnv];
    note = `（key 取自环境变量 ${apiKeyEnv}，已搬进 secrets.json）`;
    if (!apiKey) throw new Error(`环境变量 ${apiKeyEnv} 未设置或为空`);
  } else {
    apiKey = process.env[p.env];
    note = `（key 取自环境变量 ${p.env}，已搬进 secrets.json）`;
    if (!apiKey) throw new Error(`未提供 key：请设置环境变量 ${p.env}，或用 --api-key-env VAR 指定`);
  }
  const { writeConfig, writeApiKey } = await import('../dist/adapters/core/configStore.js');
  writeConfig({ provider, model: p.model, endpoint: p.endpoint });
  writeApiKey(apiKey);
  return { provider, model: p.model, endpoint: p.endpoint, note };
}

/** --prewarm-ocr：创建 chi_sim worker 识别一张内存小 BMP，使语言包落盘缓存 */
async function prewarmOcrMain() {
  let createWorker;
  try {
    ({ createWorker } = await import('tesseract.js'));
  } catch {
    throw new Error('未安装 tesseract.js（pnpm add tesseract.js），或改用配置的外部文档解码器');
  }
  // 2x2 24 位 BMP（手工构造，零依赖）
  const px = Buffer.alloc(16, 255);
  const bmp = Buffer.concat([
    Buffer.from([0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0]),
    Buffer.from([0x28, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0x18]),
    Buffer.from([0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    px,
  ]);
  process.stdout.write('预热 OCR（下载/加载 chi_sim 语言包，需联网）… ');
  const worker = await createWorker('chi_sim');
  try {
    await worker.recognize(bmp);
  } finally {
    await worker.terminate();
  }
  console.log('完成');
  const candidates = [
    join(pluginRoot, 'node_modules', '.tesseract.js-cache'),
    join(pluginRoot, 'tessdata'),
    join(process.cwd(), 'node_modules', '.tesseract.js-cache'),
  ];
  for (const d of candidates) {
    if (!existsSync(d)) continue;
    const files = readdirSync(d).filter((f) => /chi_sim/.test(f));
    if (files.length > 0) {
      let size = 0;
      for (const f of files) size += statSync(join(d, f)).size;
      console.log(`语言包缓存：${d}（${files.join('、')}，共 ${(size / 1024 / 1024).toFixed(1)} MB）`);
      return;
    }
  }
  console.log('未在常见缓存目录找到 chi_sim 文件（tesseract.js 可能使用了其他 cacheRoot）。');
}

function parseCli(argv) {
  const args = { _: [], fix: false, withPreset: false, withLlm: false, setupLlm: false, prewarmOcr: false, provider: undefined, apiKeyEnv: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--doctor': args._.push('doctor'); break;
      case '--fix': args.fix = true; break;
      case '--with-preset': args.withPreset = true; break;
      case '--with-llm': args.withLlm = true; break;
      case '--setup-llm': args.setupLlm = true; break;
      case '--prewarm-ocr': args.prewarmOcr = true; break;
      case '--provider': args.provider = next(); break;
      case '--api-key-env': args.apiKeyEnv = next(); break;
      case '--check': args._.push('check'); break;
      case '--uninstall': args._.push('uninstall'); break;
      case '--install': break;
      case '--help': case '-h': args.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`未知参数：${a}`);
    }
  }
  return args;
}

const DOCTOR_USAGE = `用法：node scripts/install-dsh.mjs [--doctor [--fix]] [--with-preset] [--setup-llm [--provider X --api-key-env VAR]] [--prewarm-ocr] [--check] [--uninstall]`;

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) { console.log(DOCTOR_USAGE); process.exit(0); }
  try {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) throw new Error(`Node 版本过低：${process.version}（需要 ≥20）`);

    if (cli._.includes('check')) {
      const s = checkStatus();
      console.log('=== 安装状态检查 ===');
      console.log(`profile 补丁：${s.patchFile}（${s.profileExists ? '存在' : '不存在'}）`);
      console.log(`MCP 注册：${s.registered ? '已注册' : '未注册'}（id: ${MCP_ID}）`);
      console.log(`MCP 产物：${s.distReady ? '就绪' : '缺失'}（${s.distEntry}）`);
      if (s.registered) {
        const llmState = serverLlmStatus();
        console.log(`server 通道 LLM：${llmState === 'enabled' ? '开启（NANGYING_MCP_LLM=1）' : llmState === 'disabled' ? '关闭（启发式）' : '未知'}`);
        console.log(`路径匹配：${s.pathMatchesPluginRoot === null ? '无法解析注册路径' : s.pathMatchesPluginRoot ? '一致 ✓' : '不一致 ✗——仓库已移动，重新运行 install 脚本更新注册'}`);
        console.log(`注册块自检：${s.blockIssues.length === 0 ? '通过 ✓' : '发现 ' + s.blockIssues.length + ' 个问题 ✗'}`);
        for (const it of s.blockIssues) {
          console.log(`  - [${it.field}] ${it.issue}`);
          console.log(`    修复建议：${it.fix}`);
        }
      }
      const ok = s.registered && s.distReady && s.blockIssues.length === 0 && s.pathMatchesPluginRoot !== false;
      process.exit(ok ? 0 : 2);
    }

    if (!existsSync(distEntry)) ensureBuild();

    if (cli._.includes('doctor')) {
      console.log('=== 环境医生（--doctor）===');
      const d = runDoctor();
      for (const it of d.items) {
        const mark = it.status === 'ok' ? '✓' : it.status === 'fail' ? '✗' : '△';
        console.log(` ${mark} [${it.label}] ${it.detail}`);
      }
      if (d.autoFixable.length > 0) {
        if (cli.fix) {
          const fixed = fixDoctorIssues();
          console.log(`
已自动修复 ${fixed.length} 项：`);
          for (const f of fixed) console.log(`  - ${f}`);
        } else {
          console.log(`
有 ${d.autoFixable.length} 项可自动修复：运行 --doctor --fix`);
        }
      }
      const hasManual = d.items.some((i) => i.status !== 'ok') &&
        (d.items.some((i) => i.status !== 'ok' && !i.autoFixable) || !cli.fix);
      process.exit(hasManual ? 1 : 0);
    }

    if (cli.withLlm) {
      const r = enableServerLlm();
      console.log(r.action === 'enabled'
        ? `server 通道 LLM 已开启（注册块注入 env.NANGYING_MCP_LLM=1，${r.file}，已备份）。大材料仍建议 CLI 跑。`
        : r.action === 'skipped' ? `server 通道 LLM：${r.note}。` : `✗ ${r.note}`);
      if (r.action === 'absent') process.exit(1);
    }

    if (cli.withPreset) {
      const r = installPreset();
      console.log(r.action === 'installed'
        ? `教学助理 preset 已注册（${r.file}，原文件已备份）。重启 DSH Desktop 后可在 preset 列表选用（未设为默认）。`
        : `教学助理 preset：${r.note}。`);
    }

    if (cli.setupLlm) {
      if (!existsSync(distEntry)) ensureBuild();
      if (cli.provider) {
        const r = await setupLlmParam({ provider: cli.provider, apiKeyEnv: cli.apiKeyEnv });
        console.log(`LLM 已配置：${r.provider} / ${r.model} / ${r.endpoint}${r.note}`);
      } else {
        const { setupLlmInteractive } = await import('./setup-llm.helper.mjs');
        await setupLlmInteractive();
      }
      console.log('生效链：宿主显式注入 > settings/secrets（本次写入）> .env（调试）。');
    }

    if (cli.prewarmOcr) {
      await prewarmOcrMain();
    }

    if (cli._.includes('uninstall')) {
      const r = uninstall();
      const patchFile = join(defaultProfileDir(), 'cordis.patch.yml');
      let presetRemoved = false;
      if (existsSync(patchFile)) {
        const t = readFileSync(patchFile, 'utf8');
        const { lines: ls, blocks } = splitTopLevelBlocks(t);
        const b = blocks.find((x) => ls.slice(x.start, x.end).join(NL).includes('id: preset-teaching-assistant'));
        if (b) {
          backup(patchFile);
          ls.splice(b.start, b.end - b.start);
          writeFileSync(patchFile, ls.join(NL).replace(new RegExp(NL + '{3,}', 'g'), NL + NL), 'utf8');
          presetRemoved = true;
        }
      }
      console.log(r.action === 'removed'
        ? `已移除 ${MCP_ID} 注册（原文件已备份）${presetRemoved ? '，并移除 preset-teaching-assistant' : ''}。重启 DSH Desktop 生效。`
        : `未找到 MCP 注册项${presetRemoved ? '；已移除 preset-teaching-assistant' : '，无需移除'}。`);
      return;
    }
    const hasMode = cli._.length > 0 || cli.withPreset || cli.withLlm || cli.setupLlm || cli.prewarmOcr;
    if (hasMode) process.exit(0);
    const r = install();
    if (r.action === 'installed') {
      console.log(`已安装：${MCP_ID} 注册追加到 ${r.file}`);
      console.log(`原文件备份：${r.backup}`);
    } else if (r.action === 'updated') {
      console.log(`注册已存在，已更新为当前路径（${r.file}）`);
    } else {
      console.log('注册已存在且路径一致，无需变更。');
    }
    console.log('');
    console.log('后续步骤：');
    console.log('  1. 重启 DSH Desktop（使 MCP 注册生效）；');
    console.log(`  2. 新建会话，确认出现 19 个 mcp__${SERVER_NAME}__* 工具（可先问 agent"列出可用工具"）；`);
    console.log('  3. 若工具未出现，运行 node scripts/install-dsh.mjs --check 查看注册块自检输出。');
    process.exit(0);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (isMain) main();
