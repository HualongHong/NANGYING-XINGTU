/**
 * --setup-llm 交互迷你向导（install-dsh.mjs 动态导入；需 dist 已构建）。
 * 写正式配置路径：~/.nangying-starmap/settings.json（644）+ secrets.json（600）。
 *
 * LLM 配置存 settings.json 的 extra.llm 子对象 —— 与顶层解码器 provider 位分离：
 * setup-llm 曾把 provider=deepseek 写在顶层，会覆盖解码器配置并被解码阶梯③当未知供应商。
 * 现 merge 写入 extra.llm，解码器配置（mineru/local-ocr/端口等 extra 字段）原样保留。
 *
 * 注意：readline/promises 在非 TTY 管道输入下遇 EOF 即静默退出（TTY 人工使用正常）——
 * 自动化验证请直接调用 writeLlmSettings，不要管道喂交互向导。
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { writeConfig, writeApiKey, readConfig } from '../dist/adapters/core/configStore.js';

const PROVIDERS = {
  '1': { id: 'deepseek', label: 'DeepSeek V4 Flash（推荐）', endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY' },
  '2': { id: 'minimax', label: 'MiniMax M3', endpoint: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3', env: 'MINIMAX_API_KEY' },
  '3': { id: 'custom', label: '自定义（OpenAI 兼容）', endpoint: '', model: '', env: '' },
};

/** merge 写入 extra.llm（保留既有解码器配置与其他 extra 字段；可独立测试） */
export function writeLlmSettings(provider, model, endpoint) {
  const prev = readConfig() ?? { provider: '' };
  writeConfig({
    ...prev,
    extra: { ...prev.extra, llm: JSON.stringify({ provider, model, endpoint }) },
  });
}

export async function setupLlmInteractive() {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('LLM 配置向导（key 仅写入本机 secrets.json，不进入配置文件/日志；输入时请注意周围环境）');
    console.log('  1. DeepSeek V4 Flash（推荐）  2. MiniMax M3  3. 自定义（OpenAI 兼容）');
    const choice = (await rl.question('选择 [1]：')).trim() || '1';
    const p = PROVIDERS[choice] ?? PROVIDERS['1'];
    const endpoint = p.id === 'custom'
      ? (await rl.question('Endpoint：')).trim()
      : (await rl.question(`Endpoint [${p.endpoint}]：`)).trim() || p.endpoint;
    const model = p.id === 'custom'
      ? (await rl.question('模型名：')).trim()
      : (await rl.question(`模型 [${p.model}]：`)).trim() || p.model;
    const envHint = p.env ? `（也可先 export ${p.env}=… 后直接回车留空）` : '';
    const apiKey = (await rl.question(`API key${envHint}：`)).trim()
      || (p.env ? (process.env[p.env] ?? '') : '');
    if (!apiKey) {
      console.error('未提供 API key，配置未写入。');
      process.exitCode = 1;
      return;
    }
    writeLlmSettings(p.id, model, endpoint);
    writeApiKey(apiKey);
    console.log(`已配置：${p.label} / ${model} / ${endpoint}（LLM 配置在 settings.json extra.llm；key 已入 secrets.json，不显示）`);
  } finally {
    rl.close();
  }
}
