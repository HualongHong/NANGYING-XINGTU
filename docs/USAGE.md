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
2. 新建 `profile.json` 能力档案（逐项标注置信度 confirmed/inferred/unknown；
   公开资料不足时一律保守默认，与 dsh/workbuddy/qoder 同型）；
3. 新建 `adapter.newplat.ts`，用共享工厂声明接线——行为零自研，全部共享 AdapterBase：

```ts
import { createPlatformAdapter } from '../core/platformAdapter.js';

export const NewplatAdapter = createPlatformAdapter({
  platform: 'newplat',
  available: ['documentParser', 'llm', 'ner', 'vectorRetrieval'],
  degradationPlan: { mtEngine: 'degraded' },
});
```

4. 在 `manifests/plugin.manifest.json` 的 `adapters` 数组中追加 `"newplat"`；
5. 在 `tests/adapterProfile.test.ts` 的 `PLATFORM_ADAPTERS` 中登记；
6. 运行 `node scripts/validate.mjs` 与 `pnpm test` 确认 manifest、目录、注册表与测试三方一致。

技能执行器由 `adapters/core/executors.ts` 共享实现，宿主侧按需经
`registerSharedSkills(adapter, { llm })` 一次性注册并注入 LLM；基类对未注册执行器的技能返回 `unavailable`。

## 4. 经适配器调用（LocalAdapter 参考实现）

```ts
import { LocalAdapter } from './adapters/core/local.adapter.js';

'const adapter = new LocalAdapter(); // 构造即注册全部 29 个技能（22 共享 + 7 特化降级实现）'
const parsed = await adapter.invokeSkill('parse_course_material', {
  inputs: { materialFile: 'materials/lecture-01.md' }, // 文件路径或 { content, materialType }
});
// parsed.level: 'full' | 'degraded' | 'unavailable'，core 的 SkillResult 原样透回
```

`registerSharedSkills(adapter, { llm })` 可重新注册并注入宿主 LLMProvider（见第 2 节）。6 个平台适配器（dsh/kimi/trae/codex/workbuddy/qoder，kimi 覆盖 KimiWORK）由 `createPlatformAdapter` 工厂生成：构造即具备能力档案与降级阶梯，技能执行器由宿主按需经 `registerSharedSkills` 注册注入。

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

## 7. 配置文档解码器

二进制文档（PDF/PPT(X)/DOC(X)/XLSX/图片）的解码双重供给：宿主注入 `ctx.decoder` 优先；否则使用本机配置的内置供应商解码器。

内置供应商：`kimi`（Moonshot 文件解析）、`openai`（OpenAI 兼容视觉）、`mineru`（OpenDataLab 高精度解析——表格→HTML、公式→LaTeX；**免 key 免费档** ≤10MB/20 页仅 Markdown，配 `MINERU_API_TOKEN`（mineru.net 控制台申请）走精准档异步任务，每日免费高优额度以官网为准）。

```bash
pnpm build
pnpm config    # 交互向导（不回显 key；配置的是文档解码器）
# 或参数模式（CI 友好）：
pnpm config --provider kimi --model moonshot-v1-8k --endpoint https://api.moonshot.cn --api-key-env MOONSHOT_KEY
pnpm config --provider mineru   # 免 key：免费档；--api-key 传入则精准档
pnpm config --show    # 显示当前配置（脱敏，不回显 key；含 extra.llm 的 LLM 配置行）
pnpm config --clear   # 清除密钥
```

LLM（讲稿润色/词族派生等）与解码器分位存放：`node scripts/install-dsh.mjs --setup-llm` 写入 `settings.json` 的 `extra.llm`，`pnpm config` 不动它；`.env` 调试通道 `NANGYING_LLM_PROVIDER/_MODEL/_ENDPOINT` 或各厂商 `*_API_KEY`。

学术证据（可选）：`enrich_knowledge_evidence` 技能经 SciVerse（OpenDataLab 学术基座）为图谱逐概念挂学术引用；Token 用 settings_card 的学术证据区块写入命名密钥 `sciverseApiKey`，或 `.env` 的 `SCIVERSE_API_TOKEN` 调试通道。无 Token 时技能返回 `degraded` 且图谱不动，主流程不中断。

数据集探查（可选）：`inspect_teaching_dataset` 技能探查 OpenDataLab 数据集仓库（元信息+文件清单+教学相关性评分）；**公共仓库匿名零配置可用**，受限仓库经 settings_card 数据集区块写入 `odlabAccessKeyId`/`odlabSecretAccessKey`（AK/SK 成对，0600），或 `.env` 的 `OPENXLAB_AK`/`OPENXLAB_SK`。

科教融合备课（可选，五技能链，纯本地零密钥）：给定课程章节 + 会议摘要集产四件套（课件 PDF / 阅读材料 A4 PDF / 课后自测离线 HTML / 教案 PDF）——`gather_teaching_requirements`（开工必问 Q1–Q8 + 纠偏登记表，stopWork 时逐项问不预设）→ `parse_abstract_collection`（分页文本/pdftotext 直出：结构化记录 + 页号偏移 Δ 探测 + 抽取缺陷旗标）→ `select_research_evidence`（词族加权评分 + 相对分位阈值 + 覆盖优先 + 复核队列，LLM 在场自动派生词族）→ `compose_teaching_artifacts`（编号单一来源 + 来源字段"未提供"口径 + 学生/教师信息边界校验）→ `audit_teaching_package`（零外链/禁用词/占位符/编号一致/来源口径/奇偶配对纯检查 + 编译写盘 delegated 指引 + 红线触发清单）。详见 [RECIPES.md 配方 5](RECIPES.md)。

教学知识库（可选，KAG-1，纯本地零密钥）：多材料课程建一次库、六环节统一取材——`build_teaching_knowledge_base`（材料+图谱 → 概念分层/段落级证据/关联/索引 + `coverageGaps` 缺口清单 + `acquisitionPlan` 采集清单，默认落盘 `configDir()/kb/<kbId>/`，大语料 `async: true`）→ `query_teaching_knowledge_base`（倒排∪图谱扩展混合检索出证据包，得分构成与出处逐条可见；`mode:'reason'` 走 KAG-lite 逻辑式推理承接多跳/聚合/比较问题，需宿主 LLM，降级自动回落 retrieve）→ 教案/讲稿/测试/辅导/课件经可选 `kbRefs` 消费（缺省行为不变）。开放采集回路：`coverageGaps` → 三通道采集（SciVerse/摘要集/公开材料）→ build `base` 合并 + `externalConcepts` + `llmLinkProposals`（mustReview）→ `confirmReview` 人工确认。详见 [RECIPES.md 配方 6](RECIPES.md)。

向量召回增强（可选）：settings_card 的 embeddings 区块配置 OpenAI 兼容端点（`embeddingsBaseUrl`/`embeddingsModel`/`embeddingsApiKey`，存 `extra.embeddings` + 命名密钥，与 extra.llm 同纪律），或 `.env` 的 `NANGYING_EMBEDDINGS_BASE_URL`/`NANGYING_EMBEDDINGS_MODEL`/`NANGYING_EMBEDDINGS_API_KEY`；宿主亦可经 `ctx.embedder` 直接注入。配置后 build 自动构建向量索引（增量缓存：同文本同模型复用）、query 自动融合向量召回；缺席/失败自动纯倒排降级，主流程不受影响。MCP/HTTP server 通道需 `NANGYING_MCP_EMBEDDINGS=1` opt-in。**换嵌入模型须重建知识库**（向量维度校验拦截混用）。

**密钥安全策略**（key 生命周期）：
- 存放：配置目录 `~/.nangying-starmap/`（可用 env `NANGYING_CONFIG_DIR` 覆盖）；`settings.json` 只存非敏感配置（644），`secrets.json` 存命名密钥映射 `{ "apiKey": …, "sciverseApiKey": …, "odlabAccessKeyId": …, "odlabSecretAccessKey": … }`（600；缺省名 `apiKey` 与旧文件兼容；Windows 下 chmod 尽力而为，建议再以文件系统 ACL 收紧目录访问）；
- 写入：`writeConfig` 入参校验拒绝任何字段名含 key/token/secret/password 的配置；向导与参数模式均不回显 key；
- 读取：解码器工厂以 `keyProvider: () => readApiKey()` 在**请求时刻**惰性读取，不缓存、不打印；
- 使用：密钥只出现在请求的 `Authorization` 头中；
- 错误脱敏：响应/错误文本中如出现 key 子串，替换为 `***`（`redact` 工具）；代码与日志永不接触明文 key。
