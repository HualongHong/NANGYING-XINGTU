/**
 * 真实 LLM 术语度过滤验收脚本（多模型验收支持）。
 *
 * 用法：
 *   pnpm build                    # 先编译（脚本消费 dist）
 *   pnpm config --provider kimi --api-key-env MOONSHOT_KEY   # 配置 LLM（密钥进 secrets.json）
 *   node scripts/eval-llm-filter.mjs                        # 用 settings.json 的配置跑全量
 *   node scripts/eval-llm-filter.mjs --provider minimax --model MiniMax-M3 \
 *     --endpoint https://api.minimaxi.com/v1 --materials 讲义,米氏常数,纸层析 --out result.json
 *
 * CLI 覆盖参数（缺省回退 settings.json 的值）：
 *   --provider X --model Y --endpoint URL   # 同一份 secrets，切换入口各跑一次
 *   --api-key-env VAR                       # 从环境变量取 key（见下）
 *   --materials 讲义,米氏常数                 # 逗号分隔或 *glob* 文件名过滤（默认全量）
 *   --out FILE                              # 四类分布 + 样例 JSON 落盘（默认仅 stdout）
 *
 * 密钥三种配法（优先级从高到低）：
 *   1) --api-key-env VAR：从该环境变量取；
 *   2) 内置 provider→环境变量映射：minimax→MINIMAX_API_KEY、deepseek→DEEPSEEK_API_KEY、
 *      kimi/moonshot→MOONSHOT_API_KEY——填仓库根 .env（已 gitignore + ACL 收紧，安全约定见 .env.example）；
 *   3) ~/.nangying-starmap/secrets.json（configStore 惰性读取）。
 * 安全约定：.env 永不进 git；脚本任何路径都不打印 key 本体（错误响应经 *** 脱敏）。
 *
 * OpenAI 兼容端点示例（注意：用户宿主里的 /anthropic 前缀是 Anthropic 协议路径，
 * 本脚本走 OpenAI 协议，端点不同但账号 key 通用，勿照抄宿主配置）：
 *   - MiniMax M3：        --endpoint https://api.minimaxi.com/v1 --model MiniMax-M3
 *   - DeepSeek V4 Flash： --endpoint https://api.deepseek.com --model deepseek-flash
 *     （注意：该端点接受的模型名是 deepseek-flash，"DeepSeek-v4-flash" 会被 HTTP 400 拒绝）
 *
 * 从 configStore 读取 settings/secrets（密钥惰性读取，绝不打印），
 * 对 testfiles/生物化学实验 的候选池跑真实四类分类过滤。
 * 未配置 key 或参数错误时给出中文指引并退出。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../dist/adapters/core/configStore.js';

import { loadDotEnv } from '../dist/adapters/core/dotenv.js';
loadDotEnv(join(process.cwd(), '.env'));

const USAGE = `用法：node scripts/eval-llm-filter.mjs [选项]
  --provider X      提供商（缺省取 settings.json 的 provider）
  --model Y         模型名（缺省取 settings.json 的 model）
  --endpoint URL    OpenAI 兼容端点（缺省取 settings.json 的 endpoint）
  --api-key-env V   从环境变量 V 取 key（也可用 .env 的 MINIMAX_API_KEY/DEEPSEEK_API_KEY/MOONSHOT_API_KEY）
  --materials 列表  逗号分隔或 *glob* 文件名过滤（默认全量 15 材料）
  --out FILE        结果 JSON 落盘（默认仅打印 stdout）
  --help            显示本用法
示例：
  node scripts/eval-llm-filter.mjs --provider minimax --model MiniMax-M3 \\
    --endpoint https://api.minimaxi.com/v1 --materials 讲义,米氏常数,纸层析`;

function parseArgs(argv) {
  const args = { provider: undefined, model: undefined, endpoint: undefined, apiKeyEnv: undefined, materials: undefined, out: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        console.error(`✗ 参数 ${a} 缺少值\n\n${USAGE}`);
        process.exit(1);
      }
      return v;
    };
    switch (a) {
      case '--provider': args.provider = next(); break;
      case '--model': args.model = next(); break;
      case '--endpoint': args.endpoint = next(); break;
      case '--api-key-env': args.apiKeyEnv = next(); break;
      case '--materials': args.materials = next(); break;
      case '--out': args.out = next(); break;
      case '--help': case '-h': args.help = true; break;
      default:
        console.error(`✗ 未知参数：${a}\n\n${USAGE}`);
        process.exit(1);
    }
  }
  for (const k of ['provider', 'model', 'endpoint', 'apiKeyEnv', 'materials', 'out']) {
    if (args[k] !== undefined && (typeof args[k] !== 'string' || args[k] === '')) {
      console.error(`✗ 参数 --${k} 缺少值\n\n${USAGE}`);
      process.exit(1);
    }
  }
  return args;
}

const cli = parseArgs(process.argv.slice(2));
if (cli.help) {
  console.log(USAGE);
  process.exit(0);
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// 读取配置（复用适配层路径约定）
const settingsFile = join(configDir(), 'settings.json');
const secretsFile = join(configDir(), 'secrets.json');
// settings.json 仅为回退配置：CLI 与 .env 齐全时无需此文件
const config = existsSync(settingsFile)
  ? JSON.parse(readFileSync(settingsFile, 'utf8'))
  : {};

// 密钥解析：--api-key-env → provider→环境变量映射（.env）→ secrets.json，全程不打印 key
const cliProviderLower = (cli.provider ?? config.provider ?? '').toLowerCase();
const ENV_KEY_MAP = {
  minimax: 'MINIMAX_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
};
let apiKey;
let keySource = '';
if (cli.apiKeyEnv) {
  apiKey = process.env[cli.apiKeyEnv];
  keySource = `环境变量 ${cli.apiKeyEnv}`;
}
if (!apiKey && ENV_KEY_MAP[cliProviderLower]) {
  apiKey = process.env[ENV_KEY_MAP[cliProviderLower]];
  keySource = `环境变量 ${ENV_KEY_MAP[cliProviderLower]}（.env）`;
}
if (!apiKey && existsSync(secretsFile)) {
  apiKey = JSON.parse(readFileSync(secretsFile, 'utf8')).apiKey ?? undefined;
  keySource = `secrets.json（${secretsFile}）`;
}
if (!apiKey) {
  fail([
    '未配置 API key。三种配法：',
    '  1) 仓库根 .env 填 MINIMAX_API_KEY / DEEPSEEK_API_KEY（见 .env.example，永不进 git）；',
    '  2) --api-key-env VAR 从环境变量取；',
    '  3) pnpm config 向导写入 ' + secretsFile + '。',
  ].join(String.fromCharCode(10)));
}
console.log(`密钥来源：${keySource}（值不显示）`);

const provider = cliProviderLower;
// 端点归一：OpenAI 兼容 chat/completions（自动补 /v1/chat/completions 或 /chat/completions）
function resolveEndpoint(raw) {
  let e = (raw ?? '').replace(/\/$/, '');
  if (!e) {
    e = provider === 'kimi' || provider === 'moonshot'
      ? 'https://api.moonshot.cn/v1'
      : 'https://api.openai.com/v1';
  }
  if (!/\/chat\/completions$/.test(e)) {
    e = /\/v\d$/.test(e) ? `${e}/chat/completions` : `${e}/v1/chat/completions`;
  }
  return e;
}
const endpoint = resolveEndpoint(cli.endpoint ?? config.endpoint);
const model = cli.model ?? config.model ?? (provider === 'kimi' || provider === 'moonshot' ? 'moonshot-v1-8k' : 'gpt-4o');
console.log(`=== 术语度过滤验收 ===\n提供商：${provider}  模型：${model}\n端点：${endpoint}\n`);

/** 真实 LLMProvider：OpenAI 兼容 chat/completions */
const llm = {
  async complete(prompt) {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: '你是生物化学实验课程的术语判定助手，只输出 JSON。' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const raw = await resp.text();
    if (!resp.ok) {
      // 错误脱敏：绝不打印 key
      const safe = raw.split(apiKey).join('***');
      throw new Error(`LLM 请求失败 HTTP ${resp.status}：${safe.slice(0, 200)}`);
    }
    const parsed = JSON.parse(raw);
    const content = parsed.choices?.[0]?.message?.content ?? '';
    // 推理模型（如 MiniMax-M3）会在正文前输出 <think>...</think> 推理块，
    // 剥离后再交下游 JSON 解析（core 层只去代码围栏，不识 think 标签）
    return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  },
};

// 材料清单：pptx 走解码缓存，pdf 用 _pdf 预处理文本
const { LocalAdapter } = await import('../dist/adapters/core/local.adapter.js');
const { registerSharedSkills } = await import('../dist/adapters/core/executors.js');
const adapter = new LocalAdapter();
registerSharedSkills(adapter, { llm }); // 注入真实 LLM，术语度过滤随之启用
const DIR = 'testfiles/生物化学实验';
const strip = (t) => t.split('\n').filter((l) => !/^===\s*第\d+页\s*===$/.test(l.trim())).join('\n');
const pdfDir = join(DIR, '_pdf');
const units = [];
for (const f of readdirSync(DIR).filter((f) => f.endsWith('.pptx'))) {
  units.push({ name: f, input: { materialFile: join(DIR, f) } });
}
for (const f of readdirSync(pdfDir).filter((f) => f.endsWith('.txt'))) {
  units.push({ name: f.replace(/\.txt$/, '.pdf'), input: { materialFile: { content: strip(readFileSync(join(pdfDir, f), 'utf8')), materialType: 'txt' } } });
}

// --materials 过滤：逗号分隔子串匹配（可含 * 通配）
let selected = units;
if (cli.materials) {
  const rawPats = cli.materials.split(',').map((x) => x.trim()).filter(Boolean);
  const pats = rawPats.filter((x) => x.includes('*'))
    .map((x) => new RegExp('^' + x.split('*').join('.*') + '$'));
  const subs = rawPats.filter((x) => !x.includes('*'));
  selected = units.filter((u) =>
    subs.some((s) => u.name.includes(s)) ||
    pats.some((re) => re.test(u.name)));
  if (selected.length === 0) {
    fail(`--materials 未匹配任何材料（可用名：${units.map((u) => u.name).join('、')}）`);
  }
}

const dist = { term: 0, operation: 0, phrase: 0, noise: 0 };
const keptSamples = [], droppedSamples = [];
let totalCandidates = 0, totalKept = 0;
const perUnit = [];

for (const u of selected) {
  const parsed = await adapter.invokeSkill('parse_course_material', { inputs: u.input });
  const report = parsed.data?.llmFilterReport;
  const cands = parsed.data?.knowledgePointCandidates ?? [];
  if (!report?.enabled) {
    console.log(`${u.name}: 过滤未启用（候选 ${cands.length}）`);
    continue;
  }
  for (const k of Object.keys(dist)) dist[k] += report.distribution[k] ?? 0;
  totalCandidates += cands.length + report.dropped;
  totalKept += report.kept;
  for (const s of report.droppedSamples ?? []) {
    if (droppedSamples.length < 30) droppedSamples.push(s);
  }
  if (keptSamples.length < 30) {
    keptSamples.push(...cands.slice(0, 5).map((c) => c.term));
  }
  perUnit.push({ unit: u.name, kept: report.kept, dropped: report.dropped, distribution: report.distribution, degraded: report.degraded });
  const note = report.degraded && parsed.degradationNote ? ` ${parsed.degradationNote}` : '';
  console.log(`${u.name}: 候选 ${cands.length + report.dropped} → 保留 ${report.kept}（term ${report.distribution.term}/op ${report.distribution.operation}/phrase ${report.distribution.phrase}/noise ${report.distribution.noise}）${report.degraded ? ' [有批次降级]' : ''}${note}`);
}

const summary = {
  provider, model, endpoint,
  units: perUnit.length,
  candidates: totalCandidates,
  kept: totalKept,
  keepRatio: totalCandidates ? Number((totalKept / totalCandidates * 100).toFixed(1)) : 0,
  distribution: dist,
  keptSamples: [...new Set(keptSamples)].slice(0, 20),
  droppedSamples: droppedSamples.slice(0, 20),
};

console.log('\n=== 汇总 ===');
console.log(`候选总数 ${summary.candidates} → 保留 ${summary.kept}（${summary.keepRatio}%）`);
console.log(`四类分布：term ${dist.term} / operation ${dist.operation} / phrase ${dist.phrase} / noise ${dist.noise}`);
console.log(`保留样例：${summary.keptSamples.slice(0, 15).join('、')}`);
console.log(`丢弃样例：${summary.droppedSamples.slice(0, 15).map((s) => `${s.term}(${s.cls})`).join('、')}`);

if (cli.out) {
  writeFileSync(cli.out, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n结果已写入 ${cli.out}`);
}
