/**
 * --setup-llm 交互迷你向导（install-dsh.mjs 动态导入；需 dist 已构建）。
 * 写正式配置路径：~/.nangying-starmap/settings.json（644）+ secrets.json（600）。
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { writeConfig, writeApiKey } from '../dist/adapters/core/configStore.js';

const PROVIDERS = {
  '1': { id: 'deepseek', label: 'DeepSeek V4 Flash（推荐）', endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY' },
  '2': { id: 'minimax', label: 'MiniMax M3', endpoint: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3', env: 'MINIMAX_API_KEY' },
  '3': { id: 'custom', label: '自定义（OpenAI 兼容）', endpoint: '', model: '', env: '' },
};

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
    writeConfig({ provider: p.id === 'custom' ? 'custom' : p.id, model, endpoint });
    writeApiKey(apiKey);
    console.log(`已配置：${p.label} / ${model} / ${endpoint}（key 已入 secrets.json，不显示）`);
  } finally {
    rl.close();
  }
}
