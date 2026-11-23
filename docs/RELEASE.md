# 发布与上架（Release）

本插件按"单一事实源 + 平台打包器"方式分发：技能契约（`skills/**.md`）、描述元数据（`manifests/skills.meta.json`）与插件元信息（`manifests/plugin.manifest.json`）是唯一事实源，`scripts/pack-release.mjs` 依各目标平台的上架标准生成对应分发产物。**任何技能/版本变更只改事实源，重新打包即可，禁止手改产物。**

## 构建

```bash
pnpm run build          # 先产出 dist/（MCP runtime 来源）
pnpm run pack:release   # 生成 release/（gitignored，不入库）
```

产物：`release/{kimiwork,qoder,dsh,workbuddy,trae}/` 五个平台包 + `release-index.json` + `SHA256SUMS`。打包器内置敏感信息扫描（私钥/AWS AK/sk- 前缀/硬编码凭证字段），命中即中止；产物经 `tests/releasePack.test.ts`（16 例）锁定结构与平台规则。

## 各平台上架标准对照

| 平台 | 清单位置 | name 规则 | 技能命名 | 形态要点 |
| --- | --- | --- | --- | --- |
| KimiWORK / Kimi Code | `kimi.plugin.json`（插件根；与 `.kimi-plugin/plugin.json` 并存时根优先） | `[A-Za-z0-9_-]+(.…)*(@…)?`，允许 snake | snake（原始技能 ID） | `skills`/`commands` 为 `./` 路径；`mcpServers` stdio 命令支持插件根 `./` 相对路径；`interface.displayName` 上架展示 |
| Qoder | `.qoder-plugin/plugin.json`（**不放在插件根**；缺省回退 `.claude-plugin/`） | kebab-case 必填 | kebab（约定目录 `skills/<kebab>/SKILL.md`） | `.mcp.json`（无前导点 `mcp.json` 为回退，两者并存时点前优先不合并）；`qodercn plugins validate <path>` 可预检 |
| DSH（DeepSeek Harness） | `.codex-plugin/plugin.json`（回退 `.claude-plugin/`、根 `plugin.json`） | 插件名无硬性规则；**技能名铁律 `[a-z0-9]+(-[a-z0-9]+)*`** | kebab（硬转换） | git 仓库即插件，技能原地加载；`skills` 字段可省（默认扫 `skills/`）；附 preset 交付块 |
| WorkBuddy | 市场两层：根 `.codebuddy-plugin/marketplace.json` + `plugins/<name>/.codebuddy-plugin/plugin.json` | 插件名 kebab | kebab | `codebuddy plugin marketplace add <源> --name <市场>` 后 `plugin install <名>@<市场>`；组件（skill/hook/mcp）可逐项开关 |
| TRAE | 暂无原生插件包标准（官方社区功能请求中，2026-07 起） | — | snake（保持与 MCP 工具名一致） | 以 **MCP（mcp.json）+ 规则（`.trae/rules/`）** 分发；技能文档为 agent 按需读取的参考件 |

技能 SKILL.md 统一为：YAML frontmatter（`name`、`description` 必填）+ 契约正文原文。五个平台均为 38 技能（31 共享 + 7 特化）全量；kimiwork/qoder 另含 5 个配方命令（`recipe-1` ~ `recipe-5`，源自 `docs/RECIPES.md`）。

## 安装指引（分发包 README 同源）

- **kimiwork**：`/plugins install https://github.com/HualongHong/NANGYING-XINGTU`（或本地目录），`/reload` 生效；技能命名空间 `nangying-starmap:<技能名>`，命令 `/nangying-starmap:recipe-N`。
- **qoder**：`qodercn plugins install <目录>`；市场安装走 marketplace 注册。
- **dsh**：`dsh plugin --profile web add github:HualongHong/NANGYING-XINGTU`；preset 块可选叠加（`scripts/install-dsh.mjs --with-preset` 同源）。
- **workbuddy**：`codebuddy plugin marketplace add <目录或仓库> --name nangying && codebuddy plugin install nangying-starmap@nangying`，重启生效。
- **trae**：TRAE 设置 → MCP 添加 stdio（`node <包>/runtime/server/mcp.js`）；`rules/nangying-starmap.md` 拷入项目 `.trae/rules/`。

## MCP runtime

kimiwork/qoder/trae 三包内置 `runtime/`（`dist/` 全量拷贝，stdio 入口 `runtime/server/mcp.js`，38 个 `mcp__nangying_starmap__*` 工具）。要求本机 **Node ≥ 20**；可选引擎（sharp/tesseract.js/sciverse）为动态加载，缺失自动降级不阻断。dsh/workbuddy 包为技能+人格形态，不内嵌 runtime（宿主注入 LLM/能力）。

## 发布检查单

1. `pnpm run build && pnpm run pack:release`
2. `pnpm run validate`（九重契约校验）+ `pnpm test`（含 releasePack 16 例）
3. 产物冒烟：`printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node release/kimiwork/runtime/server/mcp.js` 应回 `serverInfo: nangying-starmap/<当前版本>`（与 plugin.manifest version 一致）
4. 版本号三处对齐：`package.json`、`manifests/plugin.manifest.json`、产物清单（打包器自动取 manifest）
5. `release/` 为 gitignored——上架提交的是事实源与打包器，产物在发布工作流中生成并随 GitHub Release 附件分发
