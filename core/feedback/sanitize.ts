/**
 * 反馈脱敏：默认剔除一切敏感形态（API key/令牌/邮箱/IP/绝对路径/.env 赋值/长随机串），
 * 输出替换文本 + 脱敏清单。确定性纯函数：同输入必同输出，供反馈技能与测试共用。
 */

export interface Redaction {
  /** 规则标识（apiKey/email/ipv4/absPath/envAssignment/token32/awsKey/ghp/bearer/longSecret） */
  type: string;
  /** 人类可读标签（进脱敏清单） */
  label: string;
  /** 命中次数 */
  count: number;
}

export interface SanitizeResult {
  text: string;
  redactions: Redaction[];
}

// 有序规则：先具体后宽泛，命中即替换为占位符，避免规则间互相吞噬
const RULES: ReadonlyArray<{
  type: string;
  label: string;
  pattern: RegExp;
  replacement: string;
}> = [
  { type: 'apiKey', label: 'API key', pattern: /sk-[A-Za-z0-9]{16,}/g, replacement: '[API-key已脱敏]' },
  { type: 'token32', label: '32+位令牌', pattern: /[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]+/g, replacement: '[令牌已脱敏]' },
  { type: 'awsKey', label: 'AWS 访问密钥', pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[AWS-key已脱敏]' },
  { type: 'ghp', label: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: '[GitHub-token已脱敏]' },
  { type: 'bearer', label: 'Bearer 令牌', pattern: /Bearer\s+[A-Za-z0-9._-]{16,}/g, replacement: 'Bearer [已脱敏]' },
  { type: 'email', label: '邮箱地址', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: '[邮箱已脱敏]' },
  { type: 'ipv4', label: 'IPv4 地址', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: '[IP已脱敏]' },
  {
    type: 'absPath',
    label: '用户目录绝对路径',
    pattern: /(?:\/(?:home|Users|root)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._~+@%=-]*)*)|(?:[A-Za-z]:\\Users\\[^\s，。；]+)/g,
    replacement: '[路径已脱敏]',
  },
  {
    type: 'envAssignment',
    label: '.env 敏感赋值',
    pattern: /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|KEY))=([^\s，。；'"]{8,})/g,
    replacement: '$1=[已脱敏]',
  },
  { type: 'longSecret', label: '超长随机串', pattern: /\b[A-Za-z0-9+/=-]{48,}\b/g, replacement: '[长串已脱敏]' },
];

/**
 * 对自由文本执行全量脱敏；返回替换后文本与脱敏清单（按规则序，含命中数）。
 */
export function sanitizeText(text: string): SanitizeResult {
  let out = text;
  const redactions: Redaction[] = [];
  for (const rule of RULES) {
    const matches = out.match(rule.pattern);
    if (matches && matches.length > 0) {
      out = out.replace(rule.pattern, rule.replacement);
      redactions.push({ type: rule.type, label: rule.label, count: matches.length });
    }
  }
  return { text: out, redactions };
}

/** 敏感形态探测（不含 /g 状态，可安全重复调用） */
export function containsSensitive(text: string): boolean {
  return RULES.some((r) => new RegExp(r.pattern.source).test(text));
}

/** 脱敏清单的人类可读汇总（一行） */
export function redactionSummary(redactions: Redaction[]): string {
  if (redactions.length === 0) return '无敏感形态命中';
  return redactions.map((r) => `${r.label}×${r.count}`).join('；');
}
