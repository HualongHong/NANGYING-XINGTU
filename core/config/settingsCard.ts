/**
 * 设置卡片（settings_card）核心：平台政策矩阵 + 卡片渲染 + 应用校验。
 * 全部为确定性纯函数：IO（读写 settings/secrets）由适配层执行器完成。
 *
 * 平台政策来源：adapters/<platform>/profile.json 的 llm/接入方式事实——
 * 六个 agent 平台（dsh/kimi/trae/codex/workbuddy/qoder）均经 MCP stdio 接入、
 * 宿主注入 LLM（llm.value=true）；local 为自托管参考实现，可跑独立 HTTP 端口。
 */

/** 解码器供应商（与 cli/config.ts 的 PROVIDERS 对齐） */
export const DECODER_PROVIDERS = ['local-ocr', 'kimi', 'openai'] as const;
export type DecoderProvider = (typeof DECODER_PROVIDERS)[number];

/** 默认 HTTP JSON-RPC 端口（server/http.ts 同源） */
export const DEFAULT_HTTP_PORT = 7379;

/** 平台设置政策 */
export interface PlatformSettingsPolicy {
  platform: string;
  label: string;
  /** stdio-mcp：宿主经 MCP 接入，无独立端口概念；http-capable：可自托管 HTTP JSON-RPC */
  transport: 'stdio-mcp' | 'http-capable';
  /** 宿主经 ctx 注入 LLM（profile llm.value=true）——解码器 API key 为可选项 */
  hostLlm: boolean;
  /** 面向用户的政策说明（渲染卡片时透出） */
  note: string;
}

/** 已知平台政策矩阵（profile.json 事实的静态投影；未知平台走 GENERIC_POLICY 保守档） */
export const PLATFORM_POLICIES: Record<string, PlatformSettingsPolicy> = {
  dsh: {
    platform: 'dsh',
    label: 'DSH',
    transport: 'stdio-mcp',
    hostLlm: true,
    note: '经 MCP stdio 接入（preset 安装）；宿主可注入 LLM，解码器 key 仅在扫描件 OCR 走视觉模型时需要',
  },
  kimi: {
    platform: 'kimi',
    label: 'Kimi Code CLI / KimiWORK',
    transport: 'stdio-mcp',
    hostLlm: true,
    note: '经 MCP stdio 接入；宿主自带 Moonshot LLM（confirmed），解码器建议 local-ocr（免费离线）',
  },
  trae: {
    platform: 'trae',
    label: 'Trae IDE',
    transport: 'stdio-mcp',
    hostLlm: true,
    note: '经 MCP stdio 接入；宿主内置多模型（confirmed），解码器 key 仅在视觉 OCR 时需要',
  },
  codex: {
    platform: 'codex',
    label: 'Codex CLI',
    transport: 'stdio-mcp',
    hostLlm: true,
    note: '经 MCP stdio 接入；宿主即 OpenAI 编码模型（confirmed），解码器 key 仅在视觉 OCR 时需要',
  },
  workbuddy: {
    platform: 'workbuddy',
    label: 'WorkBuddy',
    transport: 'stdio-mcp',
    hostLlm: true,
    note: '经 MCP stdio 接入（保守档案，待平台方确认）；假定宿主可注入 LLM',
  },
  qoder: {
    platform: 'qoder',
    label: 'QoDER',
    transport: 'stdio-mcp',
    hostLlm: true,
    note: '经 MCP stdio 接入（保守档案，待平台方确认）；假定宿主可注入 LLM',
  },
  local: {
    platform: 'local',
    label: '本地自托管',
    transport: 'http-capable',
    hostLlm: false,
    note: '自托管参考实现：MCP stdio 与独立 HTTP JSON-RPC 均可；LLM 缺省回退 .env / secrets.json',
  },
};

/** 未识别平台的保守政策：按 stdio MCP 对待，端口不开放 */
export const GENERIC_POLICY: PlatformSettingsPolicy = {
  platform: 'generic',
  label: '未识别平台',
  transport: 'stdio-mcp',
  hostLlm: false,
  note: '保守策略：密钥本机 600 存储、永不回显；未确认接入方式前不开放端口设置（自托管 HTTP 请显式 platform="local"）',
};

export function resolvePolicy(platform?: unknown): PlatformSettingsPolicy {
  if (typeof platform === 'string' && platform in PLATFORM_POLICIES) {
    return PLATFORM_POLICIES[platform];
  }
  return GENERIC_POLICY;
}

/** 卡片字段（宿主据此渲染真实 UI；secret 字段必须用密码输入框且不落日志） */
export interface SettingsField {
  name: string;
  label: string;
  kind: 'enum' | 'string' | 'url' | 'secret' | 'port';
  required: boolean;
  default?: string;
  options?: readonly string[];
  min?: number;
  max?: number;
  /** 该字段的平台政策说明 */
  policy: string;
  /** true=密钥类字段：不回显、不进日志/反馈、落盘 600 */
  secret?: boolean;
}

export interface SettingsSection {
  id: 'decoder' | 'transport';
  title: string;
  visible: boolean;
  hiddenReason?: string;
  fields: SettingsField[];
}

export interface SettingsCard {
  schema: 1;
  kind: 'settings-card';
  platform: string;
  platformLabel: string;
  title: string;
  sections: SettingsSection[];
  /** 平台政策要点（密钥/端口/LLM 注入的硬约束，宿主须遵守） */
  policyNotes: readonly string[];
}

const SECRET_STORAGE_NOTE = '只写入本机 secrets.json（0600），任何阶段不回显、不进日志/反馈/仓库';

/** 按平台政策渲染设置卡片（解码器区块恒在；端口区块随 transport 显隐） */
export function renderSettingsCard(policy: PlatformSettingsPolicy): SettingsCard {
  const portVisible = policy.transport === 'http-capable';
  const keyPolicy = policy.hostLlm
    ? `可留空（宿主经 ctx 注入 LLM）；视觉 OCR 后端需要时填写。${SECRET_STORAGE_NOTE}`
    : `视觉 OCR 后端需要时填写；local-ocr 免费离线不需要。${SECRET_STORAGE_NOTE}`;
  return {
    schema: 1,
    kind: 'settings-card',
    platform: policy.platform,
    platformLabel: policy.label,
    title: '囊萤星图 · 设置卡片',
    sections: [
      {
        id: 'decoder',
        title: '文档解码器（OCR/视觉解析）',
        visible: true,
        fields: [
          {
            name: 'provider',
            label: '解码器供应商',
            kind: 'enum',
            required: true,
            options: DECODER_PROVIDERS,
            default: 'local-ocr',
            policy: 'local-ocr 离线免费（tesseract.js）；kimi/openai 为云端视觉解析，需 API key',
          },
          {
            name: 'model',
            label: '模型',
            kind: 'string',
            required: false,
            default: 'moonshot-v1-8k（kimi）/ gpt-4o（openai）',
            policy: '留空用供应商默认模型',
          },
          {
            name: 'endpoint',
            label: 'API Endpoint',
            kind: 'url',
            required: false,
            default: 'https://api.moonshot.cn（kimi）/ https://api.openai.com/v1（openai）',
            policy: '仅接受 http(s) URL；留空用供应商默认地址',
          },
          {
            name: 'apiKey',
            label: 'API Key',
            kind: 'secret',
            required: false,
            secret: true,
            policy: keyPolicy,
          },
        ],
      },
      {
        id: 'transport',
        title: '连接端口（HTTP JSON-RPC）',
        visible: portVisible,
        ...(portVisible
          ? {}
          : { hiddenReason: '本平台经 MCP stdio 接入，无需连接端口；独立 HTTP 模式见 platform="local"' }),
        fields: [
          {
            name: 'port',
            label: '监听端口',
            kind: 'port',
            required: false,
            default: String(DEFAULT_HTTP_PORT),
            min: 1,
            max: 65535,
            policy: '仅绑定 127.0.0.1，不对公网暴露；生效于自托管 HTTP 模式（server/http.ts）',
          },
        ],
      },
    ],
    policyNotes: [
      `平台政策（${policy.label}）：${policy.note}`,
      '密钥类字段永不回显明文：status 只报后 4 位指纹；卡片/日志/反馈一律不含 key',
      '端口设置仅 http-capable 平台可见；取值 1-65535，绑定 127.0.0.1',
    ],
  };
}

/** apply 入参（settings 对象）；apiKey 缺省=不动，空字符串=清除 */
export interface ApplySettings {
  provider?: string;
  model?: string;
  endpoint?: string;
  apiKey?: string;
  port?: number | string;
}

export type ValidatedSettings = Required<Pick<ApplySettings, 'provider'>> & Omit<ApplySettings, 'provider'>;

export type ApplyValidation = { ok: true; value: ValidatedSettings } | { error: string };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** 校验 apply 入参（平台政策在此强制执行：stdio 平台拒绝端口设置） */
export function validateApplySettings(
  settings: unknown,
  policy: PlatformSettingsPolicy,
): ApplyValidation {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return { error: 'settings 必须为对象，如 { "provider": "local-ocr" }' };
  }
  const s = settings as Record<string, unknown>;
  const out: ApplySettings = {};

  if (s.provider !== undefined) {
    if (!(DECODER_PROVIDERS as readonly string[]).includes(s.provider as string)) {
      return { error: `provider 非法：${String(s.provider)}（可选：${DECODER_PROVIDERS.join('、')}）` };
    }
    out.provider = s.provider as string;
  }
  if (s.model !== undefined) {
    if (!isNonEmptyString(s.model)) return { error: 'model 须为非空字符串' };
    out.model = s.model.trim();
  }
  if (s.endpoint !== undefined) {
    if (!isNonEmptyString(s.endpoint)) return { error: 'endpoint 须为非空字符串' };
    try {
      const u = new URL(s.endpoint.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      return { error: `endpoint 须为 http(s) URL：${s.endpoint}` };
    }
    out.endpoint = s.endpoint.trim();
  }
  if (s.apiKey !== undefined) {
    if (typeof s.apiKey !== 'string') return { error: 'apiKey 须为字符串' };
    out.apiKey = s.apiKey; // ''=清除；trim 交由存储层语义，原样写入避免截断合法 key
  }
  if (s.port !== undefined) {
    if (policy.transport !== 'http-capable') {
      return { error: `平台 ${policy.platform} 经 MCP stdio 接入，无需端口（独立 HTTP 模式请用 platform="local"）` };
    }
    const n = typeof s.port === 'number' ? s.port : Number(s.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { error: `port 须为 1-65535 整数：${String(s.port)}` };
    }
    out.port = n;
  }
  if (Object.keys(out).length === 0) {
    return { error: 'settings 为空：至少提供 provider/model/endpoint/apiKey/port 之一' };
  }
  if (out.provider === undefined) {
    return { error: 'provider 必填（应用设置须指明解码器供应商，如 "local-ocr"）' };
  }
  return { ok: true, value: out as ValidatedSettings };
}

/** 密钥指纹：只暴露后 4 位，其余一律不可见 */
export function secretFingerprint(apiKey: string): string {
  const tail = apiKey.slice(-4);
  return `…${tail}`;
}
