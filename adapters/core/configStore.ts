/**
 * 配置与密钥存储（适配层）。
 *
 * 安全策略（key 与配置分离存放）：
 *  - settings.json：非敏感配置（provider/model/endpoint/timeoutMs/extra），644；
 *  - secrets.json：命名密钥映射 { "<name>": "<secret>" }，缺省名 'apiKey'（向后兼容），600
 *    （Windows 下 chmod 尽力而为，建议再以文件系统 ACL 收紧，见 docs/USAGE.md）；
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

/** 密钥名白名单形态（命名多密钥：apiKey / mineruApiKey / sciverseApiKey …） */
const SECRET_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;

function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) {
    throw new Error(`密钥名 "${name}" 非法：须为字母开头的 1-32 位字母数字`);
  }
}

/** 写密钥（secrets.json，600；name 缺省 'apiKey'，与旧单密钥文件兼容，合并写入不清其他密钥） */
export function writeApiKey(apiKey: string, name = 'apiKey'): void {
  if (!apiKey || apiKey.trim() === '') throw new Error('API key 不能为空');
  assertSecretName(name);
  mkdirSync(configDir(), { recursive: true });
  const existing = readSecretsFile();
  writeFileSync(secretsPath(), JSON.stringify({ ...existing, [name]: apiKey }, null, 2), 'utf8');
  tryChmod(secretsPath(), 0o600);
}

function readSecretsFile(): Record<string, unknown> {
  if (!existsSync(secretsPath())) return {};
  try {
    const parsed = JSON.parse(readFileSync(secretsPath(), 'utf8')) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 读密钥（name 缺省 'apiKey'）；不存在返回 undefined，不抛错 */
export function readApiKey(name = 'apiKey'): string | undefined {
  assertSecretName(name);
  const parsed = readSecretsFile();
  const v = parsed[name];
  return typeof v === 'string' && v ? v : undefined;
}

/** 清除指定密钥（name 缺省 'apiKey'；文件置空该字段，保留其他命名密钥） */
export function clearApiKey(name = 'apiKey'): void {
  assertSecretName(name);
  if (existsSync(secretsPath())) {
    const existing = readSecretsFile();
    delete existing[name];
    writeFileSync(secretsPath(), JSON.stringify(existing, null, 2), 'utf8');
  }
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows 等不支持 POSIX 权限的平台：尽力而为，建议用文件系统 ACL 收紧
  }
}
