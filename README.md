# 囊萤星图（Nangying StarMap）

> 聚萤成星，一图开课。

知识图谱驱动的慕课智造与准备插件：以一份课程知识图谱为"星图"，把散落的课程材料汇聚成结构化、可多语种交付的慕课。

## 核心隐喻

"囊萤"取自车胤囊萤夜读的典故——零散的材料如萤火微光；"星图"指课程知识图谱，将所有知识点定位、连线。插件做的事，就是把萤火聚成星图，再从星图一键开课。

## 技能分层

```
囊萤星图（29 个技能全部实现并注册）
├── 共享型技能（12 个，平台无关，任何 agent 可直接消费）
│   └── 解析 → 图谱 → 融合/比对 → 结构 → 脚本 → 翻译/问答 → 路径/反馈 → 导出/资产
└── 特化型技能（7 个，依赖外部引擎，降级实现已就绪：缺能力时产出可演示的降级形态）
    └── 数字分身 / 视频 / 语音 / 多师协同 / 场景 / 多语同步 / 实时问答
```

## 快速开始（如何被 agent 消费）

1. **读 manifest**：读取 `manifests/plugin.manifest.json`，获取插件身份、技能清单、适配平台与能力声明。
2. **查注册表**：按 skillId 查询 `manifests/skills.registry.json`，得到输入、输出、依赖与降级策略。
3. **读技能文档**：打开注册表 `docPath` 指向的 `skills/<type>/<skill_id>.md`，按"调用示例"构造请求。

插件通过 MCP 优先、HTTP/JSON-RPC 兼容的协议对外提供调用；代码只落在适配层（`adapters/`）。

## 文档解码与 LLM

- **文档解码**：二进制文档（PDF/PPTX）默认走本地 OCR（tesseract.js，PPTX 原生文本优先、纯图片课件逐页 OCR、非光栅自动跳过），解码结果按内容哈希缓存；宿主亦可注入 `ctx.decoder` 或配置外部供应商（kimi/openai 视觉）。
- **LLM 术语过滤**：推荐 **DeepSeek V4 Flash**（OpenAI 兼容，API 实际模型名 `deepseek-flash`；MiniMax M3 已验证兼容，作备选）。仓库根 `.env` 填 `DEEPSEEK_API_KEY` / `MINIMAX_API_KEY` 即可被 LocalAdapter 自动加载（已 gitignore，永不提交）；验收脚本 `scripts/eval-llm-filter.mjs`。

## 目录结构

```
├── core/                  # 领域核心（零 Node API）：nlp 解析与 MRS 候选/LLM 术语过滤、graph 星图与融合比对、course、qa、i18n、decode 契约
├── skills/                # 技能契约（Markdown：shared 23 + specialized 7，各含机器可读「输入声明」段）
├── adapters/              # 适配层（允许 Node API）
│   ├── core/              # 基类/执行器/本地适配器/解码器（OCR、PPTX、缓存、.env LLM 回退）
│   └── dsh|kimi|trae|codex|workbuddy|qoder/  # 各平台适配器 + profile.json 能力档案
├── server/                # MCP（stdio）与 HTTP JSON-RPC 最小协议层
├── manifests/             # plugin.manifest.json、skills.registry.json（gen-registry 生成）、skills.meta.json
├── docs/                  # 用户文档：技能速查、接入指南、工作流配方（开发过程文档一律不入库）
└── scripts/               # validate.mjs 三方一致性自检、gen-registry.mjs 注册表生成、ci.mjs
```

## 常用命令

```bash
node scripts/validate.mjs   # 契约三方一致性自检（md 声明 ↔ 注册表 ↔ 执行器）
pnpm run gen:registry       # 由契约声明段重新生成注册表（改入参后执行）
pnpm run ci                 # 校验 + 类型检查 + 测试（441 用例）
pnpm config                 # 解码器/LLM 配置向导
```

更多见 [CHANGELOG.md](CHANGELOG.md)、[docs/SKILLS.md](docs/SKILLS.md)、[docs/USAGE.md](docs/USAGE.md)、[docs/RECIPES.md](docs/RECIPES.md)。
