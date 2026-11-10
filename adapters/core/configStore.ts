/**
 * 配置与密钥存储（适配层）。
 *
 * 安全策略（key 与配置分离存放）：
 *  - settings.json：非敏感配置（provider/model/endpoint/timeoutMs/extra），644；
 *  - secrets.json：仅 { "apiKey": "..." }，600（Windows 下 chmod 尽力而为，
 *    建议再以文件系统 ACL 收紧，见 docs/USAGE.md）；
 *  - writeConfig 入参校验：任何字段名含 key/token/secret/password（不区分大小写）
 *    即拒绝写入并提示应放 secrets；
 *  - 全程不打印密钥；readApiKey 缺失返回 undefined 不抛错。
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DecoderConfig } from '../../core/decode/documentDecoder.js';

/** 配置目录：env NANGYING_CONFIG_DIR 优先，否则 ~/.nangying-starmap/ */
export function configDir(): string {
  return process.env.NANGYING_CONFIG_DIR ?? join(homedir(), '.nangying-starmap');
}

export function settingsPath(): string {
  return join(configDir(), 'settings.json');
}

export function secretsPath(): string {
  return join(configDir(), 'secrets.json');
}

/** 敏感字段名黑名单（不区分大小写） */
const SENSITIVE_FIELD = /key|token|secret|password/i;

export function assertNoSensitiveFields(config: Record<string, unknown>): void {
  const bad = Object.keys(config).filter((k) => SENSITIVE_FIELD.test(k));
  if (bad.length > 0) {
    throw new Error(
      `配置字段 ${bad.join('、')} 疑似敏感信息：API key 请用 writeApiKey 写入 secrets.json，勿进 settings.json`,
    );
  }
}

/** 写非敏感配置（settings.json，644） */
export function writeConfig(config: DecoderConfig): void {
  assertNoSensitiveFields(config as unknown as Record<string, unknown>);
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(config, null, 2), 'utf8');
  tryChmod(settingsPath(), 0o644);
}

/** 读配置；不存在返回 undefined */
export function readConfig(): DecoderConfig | undefined {
  if (!existsSync(settingsPath())) return undefined;
  return JSON.parse(readFileSync(settingsPath(), 'utf8')) as DecoderConfig;
}

/** 写密钥（secrets.json，600；Windows 下 chmod 尽力而为） */
export function writeApiKey(apiKey: string): void {
  if (!apiKey || apiKey.trim() === '') throw new Error('API key 不能为空');
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(secretsPath(), JSON.stringify({ apiKey }, null, 2), 'utf8');
  tryChmod(secretsPath(), 0o600);
}

/** 读密钥；不存在返回 undefined，不抛错 */
export function readApiKey(): string | undefined {
  if (!existsSync(secretsPath())) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(secretsPath(), 'utf8')) as { apiKey?: unknown };
    return typeof parsed.apiKey === 'string' && parsed.apiKey ? parsed.apiKey : undefined;
  } catch {
    return undefined;
  }
}

/** 清除密钥文件 */
export function clearApiKey(): void {
  if (existsSync(secretsPath())) {
    writeFileSync(secretsPath(), '{}', 'utf8');
  }
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows 等不支持 POSIX 权限的平台：尽力而为，建议用文件系统 ACL 收紧
  }
}
