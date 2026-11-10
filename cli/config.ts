/**
 * 配置向导 CLI：交互式（readline）与参数模式双通道。
 *
 * 用法：
 *   node dist/cli/config.js                     # 交互向导
 *   node dist/cli/config.js --provider kimi --model X --endpoint Y --api-key Z
 *   node dist/cli/config.js --provider openai --api-key-env MY_KEY_ENV
 *   node dist/cli/config.js --show              # 显示当前配置（脱敏）
 *   node dist/cli/config.js --clear             # 清除密钥
 *
 * 密钥只写入本机 secrets.json（600），不回显、不进 settings/代码/日志。
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  writeConfig,
  readConfig,
  writeApiKey,
  readApiKey,
  clearApiKey,
  settingsPath,
  secretsPath,
} from '../adapters/core/configStore.js';

interface CliArgs {
  provider?: string;
  model?: string;
  endpoint?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  show?: boolean;
  clear?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--provider': args.provider = next(); break;
      case '--model': args.model = next(); break;
      case '--endpoint': args.endpoint = next(); break;
      case '--api-key': args.apiKey = next(); break;
      case '--api-key-env': args.apiKeyEnv = next(); break;
      case '--show': args.show = true; break;
      case '--clear': args.clear = true; break;
      case '--help': case '-h': args.help = true; break;
    }
  }
  return args;
}

const PROVIDERS = [
  {
    id: 'local-ocr',
    name: '本地 OCR（tesseract.js）',
    desc: '默认推荐：无需 API key，需 pnpm add tesseract.js；语言包 chi_sim+eng 首次运行自动下载',
    defaultModel: '—',
    defaultEndpoint: '—',
  },
  {
    id: 'kimi',
    name: 'Kimi（Moonshot 文件解析）',
    desc: 'POST 文件内容取回解析文本，适合 PDF/PPTX 等文档',
    defaultModel: 'moonshot-v1-8k',
    defaultEndpoint: 'https://api.moonshot.cn',
  },
  {
    id: 'openai',
    name: 'OpenAI 兼容视觉模型',
    desc: '图片 base64 进 chat/completions，逐页转录，适合扫描件 OCR',
    defaultModel: 'gpt-4o',
    defaultEndpoint: 'https://api.openai.com/v1',
  },
] as const;

/** 探测本地 OCR 引擎是否可加载（import 探测，不创建 worker、不下载语言包） */
export async function probeLocalOcr(): Promise<boolean> {
  try {
    const mod = await import('tesseract.js');
    return typeof mod.createWorker === 'function';
  } catch {
    return false;
  }
}

function summarize(localOcrAvailable?: boolean): string {
  const config = readConfig();
  const hasKey = Boolean(readApiKey());
  if (!config) return '当前无配置。运行本向导或加参数 --provider … 进行配置。';
  const lines = [
    `供应商：${config.provider}`,
  ];
  if (config.provider !== 'local-ocr') {
    lines.push(
      `模型：${config.model ?? '（默认）'}`,
      `Endpoint：${config.endpoint ?? '（默认）'}`,
      `超时：${config.timeoutMs ? `${config.timeoutMs}ms` : '（默认）'}`,
      `API key：${hasKey ? '已配置（不显示明文）' : '未配置'}`,
    );
  } else {
    lines.push(
      `本地 OCR 引擎：${localOcrAvailable === undefined ? '未探测' : localOcrAvailable ? '可加载（tesseract.js 已安装）' : '未安装（pnpm add tesseract.js）'}`,
      'API key：不需要',
    );
  }
  lines.push(`配置文件：${settingsPath()}`, `密钥文件：${secretsPath()}`);
  return lines.join('\n');
}

async function interactiveWizard(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('囊萤星图 · 文档解码器配置向导');
    console.log('请选择解码器供应商：');
    PROVIDERS.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.name}——${p.desc}`);
    });
    const choice = await rl.question(`输入编号（1-${PROVIDERS.length}，默认 1）：`);
    const provider = PROVIDERS[Math.max(0, Math.min(PROVIDERS.length - 1, (parseInt(choice, 10) || 1) - 1))];

    const model = (await rl.question(`模型 [${provider.defaultModel}]：`)).trim() || provider.defaultModel;
    const endpoint = (await rl.question(`Endpoint [${provider.defaultEndpoint}]：`)).trim() || provider.defaultEndpoint;
    console.log('API key 仅写入本机 secrets.json（权限收紧），不会进入配置文件、代码或日志。');
    const apiKey = (await rl.question('API key（输入不回显建议用参数模式）：')).trim();

    writeConfig({ provider: provider.id, model, endpoint });
    if (apiKey) writeApiKey(apiKey);
    console.log('\n配置完成：');
    console.log(summarize());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node dist/cli/config.js [--provider kimi|openai] [--model M] [--endpoint E]');
    console.log('            [--api-key K | --api-key-env ENV] | [--show] | [--clear]');
    return;
  }
  if (args.show) {
    console.log(summarize());
    return;
  }
  if (args.clear) {
    clearApiKey();
    console.log('已清除密钥（secrets.json 置空）。');
    return;
  }
  if (args.provider) {
    const known = PROVIDERS.find((p) => p.id === args.provider);
    if (!known) {
      console.error(`未知供应商："${args.provider}"（可选：${PROVIDERS.map((p) => p.id).join('、')}）`);
      process.exitCode = 1;
      return;
    }
    const apiKey = args.apiKey ?? (args.apiKeyEnv ? process.env[args.apiKeyEnv] : undefined);
    if (args.apiKeyEnv && !apiKey) {
      console.error(`环境变量 ${args.apiKeyEnv} 未设置或为空`);
      process.exitCode = 1;
      return;
    }
    writeConfig({
      provider: known.id,
      model: args.model ?? known.defaultModel,
      endpoint: args.endpoint ?? known.defaultEndpoint,
    });
    if (apiKey) writeApiKey(apiKey);
    console.log('配置完成（密钥不回显）：');
    console.log(summarize());
    return;
  }
  await interactiveWizard();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

export { parseArgs, summarize, PROVIDERS };
