# 接入指南（面向 agent 开发者）

## 1. 注册技能

适配器基类 `adapters/core/adapter.base.ts` 提供统一接口：

```ts
import { DshAdapter } from './adapters/dsh/adapter.dsh.js';
import registry from './manifests/skills.registry.json' with { type: 'json' };

const adapter = new DshAdapter();
for (const skill of registry.skills) {
  adapter.registerSkill(skill, myExecutors[skill.skillId]); // 执行器可选
}
```

- `registerSkill(descriptor, executor?)`：登记技能描述符；`executor` 为 `(inputs) => Promise<unknown>` 的执行函数。
- `invokeSkill(skillId, { inputs })`：调用技能，返回 `SkillResult`，其中 `level` 为 `full | degraded | unavailable`。
- `getCapabilities()`：返回本平台能力档案（平台标识 + 可用能力列表 + 降级计划）。
- `fallback(skill, profile)`：按能力档案计算某技能的降级等级。

## 2. 按能力档案启用/降级特化技能

每个适配器重写 `getCapabilities()`：

```ts
getCapabilities(): CapabilityProfile {
  return {
    platform: 'my-platform',
    available: ['llm', 'ttsEngine'],              // 已确认可用的能力
    degradationPlan: {
      vectorRetrieval: 'degraded',                // 缺失依赖的降级等级
      realtimeChannel: 'unavailable',
    },
  };
}
```

调用链：`invokeSkill()` 先核对技能 `dependsOn` 与 `available` 的差集——

- 差集为空 → `full`，正常执行；
- 部分缺失且降级计划允许 → `degraded`，按注册表中的 `degradation` 策略产出，`SkillResult.degradationNote` 说明降级原因；
- 缺失且无降级路径 → `unavailable`，返回错误说明。

特化技能（数字人、TTS、实时问答等）应始终在注册表中给出降级策略，使平台缺能力时主流程仍可走通（例如无 TTS 时以纯字幕交付）。

## 3. 新增平台适配器

1. 在 `adapters/` 下新建平台目录，如 `adapters/newplat/`；
2. 新建 `adapter.newplat.ts`，继承 `AdapterBase`：

```ts
import { AdapterBase } from '../core/adapter.base.js';
import type { CapabilityProfile } from '../../core/types.js';

export class NewplatAdapter extends AdapterBase {
  getCapabilities(): CapabilityProfile {
    return { platform: 'newplat', available: ['llm'], degradationPlan: {} };
  }
}
```

3. 在 `manifests/plugin.manifest.json` 的 `adapters` 数组中追加 `"newplat"`；
4. 运行 `node scripts/validate.mjs` 确认 manifest、注册表与目录一致。

新增适配器后应补充各技能执行器（`registerSkill` 的第二个参数）；基类对未注册执行器的技能返回 `unavailable`。

## 4. 经适配器调用（LocalAdapter 参考实现）

```ts
import { LocalAdapter } from './adapters/core/local.adapter.js';

'const adapter = new LocalAdapter(); // 构造即注册全部 29 个技能（22 共享 + 7 特化降级实现）'
const parsed = await adapter.invokeSkill('parse_course_material', {
  inputs: { materialFile: 'materials/lecture-01.md' }, // 文件路径或 { content, materialType }
});
// parsed.level: 'full' | 'degraded' | 'unavailable'，core 的 SkillResult 原样透回
```

`registerSharedSkills(adapter, { llm })` 可重新注册并注入宿主 LLMProvider（见第 2 节）。'4 个平台适配器（dsh/kimi/tare/codex）同样构造即注册全部技能，能力档案待平台对接确认（T11）。'

## 5. 启动 MCP server

```bash
pnpm build        # 编译到 dist/
pnpm serve:mcp    # stdio 换行分隔 JSON-RPC 2.0
```

实现范围：`initialize` / `tools/list` / `tools/call`（其余方法回 -32601）。示例（每行一条消息）：

```
{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"parse_course_material","arguments":{"materialFile":{"content":"# 标题\n\n正文。","materialType":"md"}}}}
```

## 6. HTTP 入口

```bash
pnpm serve:http   # 默认 127.0.0.1:7379，POST /rpc，与 MCP 同一 handler
```

```bash
curl -X POST http://127.0.0.1:7379/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 8. 配置文档解码器

二进制文档（PDF/PPTX）的解码双重供给：宿主注入 `ctx.decoder` 优先；否则使用本机配置的内置供应商解码器。

```bash
pnpm build
pnpm config    # 交互向导（不回显 key）
# 或参数模式（CI 友好）：
pnpm config --provider kimi --model moonshot-v1-8k --endpoint https://api.moonshot.cn --api-key-env MOONSHOT_KEY
pnpm config --show    # 显示当前配置（脱敏，不回显 key）
pnpm config --clear   # 清除密钥
```

**密钥安全策略**（key 生命周期）：
- 存放：配置目录 `~/.nangying-starmap/`（可用 env `NANGYING_CONFIG_DIR` 覆盖）；`settings.json` 只存非敏感配置（644），`secrets.json` 只存 `{ "apiKey": … }`（600；Windows 下 chmod 尽力而为，建议再以文件系统 ACL 收紧目录访问）；
- 写入：`writeConfig` 入参校验拒绝任何字段名含 key/token/secret/password 的配置；向导与参数模式均不回显 key；
- 读取：解码器工厂以 `keyProvider: () => readApiKey()` 在**请求时刻**惰性读取，不缓存、不打印；
- 使用：密钥只出现在请求的 `Authorization` 头中；
- 错误脱敏：响应/错误文本中如出现 key 子串，替换为 `***`（`redact` 工具）；代码与日志永不接触明文 key。
