/**
 * LLM 响应缓存（适配层，opt-in）：NANGYING_LLM_CACHE=1 时启用。
 *
 * 面向确定性批任务（术语过滤等 temperature≈0 场景）：同 prompt 重复调用直接命中
 * configDir()/cache/llm/<sha256>.json，省 token 省等待。TTL 7 天（按文件 mtime）。
 * 缓存键含 provider|model|endpoint 标签，换模型/端点自然隔离。
 * 错误不缓存；缓存读写失败静默回落真实调用。生成类任务（教案/讲稿）请勿开启——
 * 同输入恒同输出会丧失重试多样性。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './configStore.js';
import type { LLMProvider } from '../../core/llm.js';

const TTL_MS = 7 * 24 * 60 * 60_000;

export function llmCacheDir(): string {
  return join(configDir(), 'cache', 'llm');
}

/** 包装 LLMProvider 加磁盘缓存；tag 区分 provider/model/endpoint */
export function withLlmCache(inner: LLMProvider, tag: string): LLMProvider {
  return {
    async complete(prompt: string, options?: Parameters<LLMProvider['complete']>[1]): Promise<string> {
      const key = createHash('sha256').update(tag).update('\n').update(prompt).digest('hex');
      const file = join(llmCacheDir(), `${key}.json`);
      try {
        if (existsSync(file) && Date.now() - statSync(file).mtimeMs < TTL_MS) {
          const cached = JSON.parse(readFileSync(file, 'utf8')) as { response?: unknown };
          if (typeof cached.response === 'string') return cached.response;
        }
      } catch {
        // 缓存读取失败：直走真实调用
      }
      const response = await inner.complete(prompt, options);
      try {
        mkdirSync(llmCacheDir(), { recursive: true });
        writeFileSync(file, JSON.stringify({ response, at: new Date().toISOString() }), 'utf8');
      } catch {
        // 缓存写入失败不影响调用
      }
      return response;
    },
  };
}
