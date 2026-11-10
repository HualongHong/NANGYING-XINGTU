/**
 * 契约声明解析器（gen-registry.mjs 与 validate.mjs 共用，零依赖）。
 *
 * 解析技能契约 md 中「## 输入声明」段的受限 YAML 子集：
 *   usage: "一句话用法"
 *   inputs:
 *     - name: graph            # 契约真名（执行器按此校验）
 *       kind: object           # object|array|string|number|boolean|any
 *       required: true
 *       aliases: ["knowledgeGraph"]   # 兼容别名（执行器归一化时改写）
 *       hint: "期望形态说明（中文）"
 *       producer: ["extract_knowledge_graph"]  # 上游技能（谁产出这个输入）
 *
 * 值语法：双引号字符串、true/false、[..] 内联列表（元素可带引号）、裸字符串。
 */

/** 解析单个值（双引号字符串 / 布尔 / 内联列表 / 裸字符串） */
function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => {
      const t = s.trim();
      return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
    });
  }
  return v;
}

/**
 * 从 md 全文提取输入声明；找不到「## 输入声明」段返回 null。
 * @returns {{usage?: string, inputs: Array<{name: string, kind: string, required: boolean, aliases: string[], hint?: string, producer?: string[]}>} | null}
 */
export function parseDeclaration(mdText) {
  const heading = mdText.indexOf('## 输入声明');
  if (heading < 0) return null;
  const fenceOpen = mdText.indexOf('```yaml', heading);
  if (fenceOpen < 0) return null;
  const fenceClose = mdText.indexOf('```', fenceOpen + '```yaml'.length);
  if (fenceClose < 0) return null;
  const block = mdText.slice(fenceOpen + '```yaml'.length, fenceClose);

  const decl = { inputs: [] };
  let current = null;
  for (const line of block.split('\n')) {
    const itemMatch = /^\s*-\s+name:\s*(.+)$/.exec(line);
    if (itemMatch) {
      current = {
        name: String(parseValue(itemMatch[1])),
        kind: 'any',
        required: false,
        aliases: [],
      };
      decl.inputs.push(current);
      continue;
    }
    const kvMatch = /^\s*(usage|kind|required|aliases|hint|producer):\s*(.+)$/.exec(line);
    if (!kvMatch) continue;
    const [, key, raw] = kvMatch;
    if (key === 'usage') {
      decl.usage = String(parseValue(raw));
      continue;
    }
    if (!current) throw new Error(`声明字段 "${key}" 出现在任何 - name 之前`);
    const value = parseValue(raw);
    if (key === 'aliases' || key === 'producer') {
      if (!Array.isArray(value)) throw new Error(`字段 ${key} 须为内联列表：[..]`);
      current[key] = value.map(String);
    } else if (key === 'required') {
      current.required = value === true;
    } else {
      current[key] = String(value);
    }
  }
  if (decl.inputs.length === 0) throw new Error('输入声明段不含任何 - name 条目');
  for (const i of decl.inputs) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(i.name)) {
      throw new Error(`非法入参名 "${i.name}"（须为 camelCase 标识符）`);
    }
    if (!['object', 'array', 'string', 'number', 'boolean', 'any'].includes(i.kind)) {
      throw new Error(`入参 ${i.name} 的 kind "${i.kind}" 非法（object|array|string|number|boolean|any）`);
    }
  }
  return decl;
}
