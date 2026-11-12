import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAdapter } from '../adapters/core/local.adapter.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ny-settings-'));
  process.env.NANGYING_CONFIG_DIR = dir;
});
afterEach(() => {
  delete process.env.NANGYING_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

interface CardData {
  card: {
    platform: string;
    platformLabel: string;
    sections: Array<{
      id: string;
      visible: boolean;
      hiddenReason?: string;
      fields: Array<{ name: string; kind: string; secret?: boolean; default?: string; min?: number; max?: number }>;
    }>;
    policyNotes: string[];
  };
}

describe('R17 设置卡片（settings_card）', () => {
  it('render：未识别平台走 generic 保守政策——端口隐藏、密钥字段标记 secret', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('settings_card', {
      inputs: { stage: 'render', platform: 'some-unknown-host' },
    });
    expect(r.level).toBe('full');
    const d = r.data as CardData;
    expect(d.card.platform).toBe('generic');
    const transport = d.card.sections.find((s) => s.id === 'transport')!;
    expect(transport.visible).toBe(false);
    expect(transport.hiddenReason).toContain('MCP stdio');
    const decoder = d.card.sections.find((s) => s.id === 'decoder')!;
    expect(decoder.visible).toBe(true);
    const apiKey = decoder.fields.find((f) => f.name === 'apiKey')!;
    expect(apiKey.secret).toBe(true);
    expect(apiKey.kind).toBe('secret');
    const provider = decoder.fields.find((f) => f.name === 'provider')!;
    expect(provider.kind).toBe('enum');
    expect(JSON.stringify(d.card.policyNotes)).toContain('不回显');
  });

  it('render：stdio 平台（kimi）端口隐藏并注明宿主 LLM；local 平台端口可见（默认 7379，1-65535）', async () => {
    const adapter = new LocalAdapter();
    const kimi = (await adapter.invokeSkill('settings_card', {
      inputs: { stage: 'render', platform: 'kimi' },
    })).data as CardData;
    expect(kimi.card.platform).toBe('kimi');
    expect(kimi.card.platformLabel).toContain('KimiWORK');
    expect(kimi.card.sections.find((s) => s.id === 'transport')!.visible).toBe(false);
    expect(JSON.stringify(kimi.card.policyNotes)).toContain('宿主');

    const local = (await adapter.invokeSkill('settings_card', {
      inputs: { stage: 'render', platform: 'local' },
    })).data as CardData;
    const transport = local.card.sections.find((s) => s.id === 'transport')!;
    expect(transport.visible).toBe(true);
    const port = transport.fields.find((f) => f.name === 'port')!;
    expect(port.default).toBe('7379');
    expect(port.min).toBe(1);
    expect(port.max).toBe(65535);
    expect(JSON.stringify(transport.hiddenReason ?? '')).not.toContain('MCP stdio');
  });

  it('render：LocalAdapter 注入 ctx.platform=local，卡片自动匹配自托管政策', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('settings_card', { inputs: {} }); // 无 platform 入参
    expect(r.level).toBe('full');
    const d = r.data as CardData;
    expect(d.card.platform).toBe('local');
    expect(d.card.sections.find((s) => s.id === 'transport')!.visible).toBe(true);
  });

  it('apply+status：local 平台写入 settings/secrets 分离存储，回显只报后 4 位指纹', async () => {
    const adapter = new LocalAdapter();
    const apiKey = 'user-input-testkey-1234';
    const apply = await adapter.invokeSkill('settings_card', {
      inputs: {
        stage: 'apply',
        platform: 'local',
        settings: { provider: 'openai', model: 'gpt-4o', endpoint: 'https://api.openai.com/v1', apiKey, port: 8091 },
      },
    });
    expect(apply.level).toBe('full');
    const applied = apply.data as { secret: { stored: boolean; fingerprint: string }; port: number };
    expect(applied.secret.stored).toBe(true);
    expect(applied.secret.fingerprint).toBe('…1234');
    expect(applied.port).toBe(8091);

    // 密钥分离存储：settings.json 不含 key，secrets.json 含 key
    const settingsRaw = readFileSync(join(dir, 'settings.json'), 'utf8');
    expect(settingsRaw).not.toContain(apiKey);
    expect(JSON.parse(settingsRaw).provider).toBe('openai');
    expect(JSON.parse(settingsRaw).extra.port).toBe('8091');
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toContain(apiKey);

    // status 脱敏回显：只有指纹，无明文
    const status = await adapter.invokeSkill('settings_card', { inputs: { stage: 'status' } });
    const s = status.data as { provider: string; port: string; apiKey: { configured: boolean; fingerprint: string } };
    expect(s.provider).toBe('openai');
    expect(s.port).toBe('8091');
    expect(s.apiKey.configured).toBe(true);
    expect(s.apiKey.fingerprint).toBe('…1234');
    expect(JSON.stringify(status.data)).not.toContain(apiKey);
  });

  it('apply：合并语义——后次 apply 不丢前次字段；apiKey 缺省不动、空串清除', async () => {
    const adapter = new LocalAdapter();
    await adapter.invokeSkill('settings_card', {
      inputs: { stage: 'apply', platform: 'local', settings: { provider: 'kimi', model: 'moonshot-v1-8k', apiKey: 'first-key-0000' } },
    });
    // 第二次只改 provider：model 保留、密钥不动
    const second = await adapter.invokeSkill('settings_card', {
      inputs: { stage: 'apply', platform: 'local', settings: { provider: 'openai' } },
    });
    expect(second.level).toBe('full');
    const status = (await adapter.invokeSkill('settings_card', { inputs: { stage: 'status' } })).data as {
      provider: string; model: string; apiKey: { fingerprint: string };
    };
    expect(status.provider).toBe('openai');
    expect(status.model).toBe('moonshot-v1-8k');
    expect(status.apiKey.fingerprint).toBe('…0000');
    // 空串清除
    await adapter.invokeSkill('settings_card', {
      inputs: { stage: 'apply', platform: 'local', settings: { provider: 'local-ocr', apiKey: '' } },
    });
    const cleared = (await adapter.invokeSkill('settings_card', { inputs: { stage: 'status' } })).data as {
      apiKey: { configured: boolean };
    };
    expect(cleared.apiKey.configured).toBe(false);
  });

  it('apply：非法输入全部 INVALID_INPUT 且不落盘——provider 非法/endpoint 非 URL/port 越界/stdio 平台拒收 port/settings 为空/缺 provider', async () => {
    const adapter = new LocalAdapter();
    const cases: Array<Record<string, unknown>> = [
      { stage: 'apply', platform: 'local', settings: { provider: 'bad-provider' } },
      { stage: 'apply', platform: 'local', settings: { provider: 'openai', endpoint: 'ftp://x' } },
      { stage: 'apply', platform: 'local', settings: { provider: 'openai', port: 70000 } },
      { stage: 'apply', platform: 'local', settings: { provider: 'openai', port: 0 } },
      { stage: 'apply', platform: 'kimi', settings: { provider: 'openai', port: 8080 } },
      { stage: 'apply', platform: 'local', settings: {} },
      { stage: 'apply', platform: 'local', settings: { model: 'gpt-4o' } },
    ];
    for (const inputs of cases) {
      const r = await adapter.invokeSkill('settings_card', { inputs });
      expect(r.level).toBe('unavailable');
      expect(r.errorCode).toBe('INVALID_INPUT');
    }
    // stdio 平台拒收 port 的提示语命中政策
    const stdio = await adapter.invokeSkill('settings_card', {
      inputs: { stage: 'apply', platform: 'kimi', settings: { provider: 'openai', port: 8080 } },
    });
    expect(stdio.degradationNote).toContain('MCP stdio');
    // 全部拒绝：任何配置/密钥文件都不落盘
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false);
  });

  it('apply：端口数字字符串接受并规范化存储（server/http.ts 读取 extra.port 生效）', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('settings_card', {
      inputs: { stage: 'apply', platform: 'local', settings: { provider: 'local-ocr', port: '9000' } },
    });
    expect(r.level).toBe('full');
    expect((r.data as { port: number }).port).toBe(9000);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).extra.port).toBe('9000');
  });

  it('provider 枚举含 mineru；render 卡片带学术证据（SciVerse）区块', async () => {
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('settings_card', { inputs: { stage: 'render', platform: 'local' } });
    const d = r.data as CardData;
    const decoder = d.card.sections.find((s) => s.id === 'decoder')!;
    const provider = decoder.fields.find((f) => f.name === 'provider')!;
    expect(JSON.stringify(provider)).toContain('mineru');
    const academic = d.card.sections.find((s) => s.id === 'academic')!;
    expect(academic.visible).toBe(true);
    const sv = academic.fields.find((f) => f.name === 'sciverseApiKey')!;
    expect(sv.secret).toBe(true);
    expect(sv.kind).toBe('secret');
    // mineru provider 可应用
    const apply = await adapter.invokeSkill('settings_card', {
      inputs: { stage: 'apply', platform: 'local', settings: { provider: 'mineru' } },
    });
    expect(apply.level).toBe('full');
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).provider).toBe('mineru');
  });

  it('sciverseApiKey：可单独设置（不要求 provider），命名密钥存储、status 脱敏回显、空串清除', async () => {
    const adapter = new LocalAdapter();
    const apply = await adapter.invokeSkill('settings_card', {
      inputs: { stage: 'apply', platform: 'local', settings: { sciverseApiKey: 'sv-user-token-9999' } },
    });
    expect(apply.level).toBe('full');
    const applied = apply.data as { sciverse: { stored: boolean; fingerprint: string }; secret?: unknown };
    expect(applied.sciverse.stored).toBe(true);
    expect(applied.sciverse.fingerprint).toBe('…9999');
    // 命名密钥落盘，与 apiKey 分离
    const secretsRaw = readFileSync(join(dir, 'secrets.json'), 'utf8');
    expect(secretsRaw).toContain('sciverseApiKey');
    expect(JSON.parse(secretsRaw).apiKey).toBeUndefined();
    // status 只报指纹
    const status = await adapter.invokeSkill('settings_card', { inputs: { stage: 'status' } });
    const s = status.data as { sciverse: { configured: boolean; fingerprint: string } };
    expect(s.sciverse.configured).toBe(true);
    expect(s.sciverse.fingerprint).toBe('…9999');
    expect(JSON.stringify(status.data)).not.toContain('sv-user-token-9999');
    // 空串清除
    await adapter.invokeSkill('settings_card', {
      inputs: { stage: 'apply', platform: 'local', settings: { sciverseApiKey: '' } },
    });
    const cleared = (await adapter.invokeSkill('settings_card', { inputs: { stage: 'status' } })).data as {
      sciverse: { configured: boolean };
    };
    expect(cleared.sciverse.configured).toBe(false);
  });
});
