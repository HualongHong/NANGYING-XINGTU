# 架构说明

> 当前基线：v1.8.0，29 个技能（22 共享 + 7 特化降级实现），6 平台适配器（dsh/kimi/trae/codex/workbuddy/qoder，kimi 覆盖 KimiWORK 宿主）。

## 分层架构

```
┌─────────────────────────────────────────────┐
│  消费层：DSH / KimiWORK / TRAE / Codex /     │
│  WorkBuddy / QoDER 等 agent                  │
│  协议层：MCP stdio（首选）/ HTTP JSON-RPC     │
├─────────────────────────────────────────────┤
│  契约层（单一事实源）                          │
│  skills/*.md 输入声明 YAML 段（手改入口）      │
│      ↓ pnpm run gen:registry                 │
│  manifests/skills.registry.json（生成物）     │
│      ↓ pnpm run validate                     │
│  executors.ts 别名/规格（三方一致强制校验）    │
├─────────────────────────────────────────────┤
│  适配层 adapters/                             │
│  core/adapter.base.ts   统一接口 + 降级阶梯   │
│  core/platformAdapter.ts 平台接线声明工厂      │
│  core/executors.ts      29 技能执行器          │
│  core/decoders/         文档解码（OCR/PDF文本层）│
│  core/jobQueue.ts       异步作业队列           │
│  dsh|kimi|trae|codex|workbuddy|qoder/        │
│                         平台能力档案           │
├─────────────────────────────────────────────┤
│  核心层 core/（平台无关纯函数，全部确定性）     │
│  graph/   三张图谱：conceptual/experimental/  │
│           industry + fuse/diff/starmap 渲染   │
│  nlp/     材料解析、候选抽取、LLM 过滤        │
│  course/  课程结构、讲稿、导出（docx/pptx/    │
│           pdf/xlsx/scorm/ims，全部零依赖）    │
│  qa/      问答库、反馈、命题、一致性、媒体验收 │
│  i18n/    翻译、双语同步、术语表              │
│  text/    去机器味润色                        │
└─────────────────────────────────────────────┘
```

契约纪律：改技能入参只能改 `skills/<type>/<skill_id>.md` 的输入声明 YAML 段，然后 `pnpm run gen:registry` 重新生成注册表，`pnpm run validate` 强制「契约 ↔ 注册表 ↔ 执行器」三方一致——注册表禁止手写。

## 主流程调用关系

```
parse_course_material（md/docx/pptx/pdf/扫描件 OCR/文本层直读）
  → extract_knowledge_graph（conceptual / experimental / outputFormat: json|mermaid|graphml|csv|jsonld）
    → design_course_structure → generate_teaching_script
      → translate_multilingual / sync_bilingual / polish_teaching_text
      → build_qa_knowledge_base / generate_assessment
    → recommend_learning_path（可 targetOccupation 倒排）
    → generate_personalized_feedback（quiz / freeTextReport）
build_industry_graph（JD/教学标准/fields 形态）
  → link_knowledge_industry（课程×产业，供需缺口报告）
fuse/diff/audit_consistency 跨图谱与跨资产运维
全部汇入 export_course_package（scorm/ims/docx/pptx/pdf/xlsx/starmap）
manage_course_assets / manage_async_tasks 承载持久化与长任务
```

## 三张知识图谱

| graphType | 本体 | 典型用途 |
|---|---|---|
| conceptual（默认） | 概念/章节，contains/prerequisite/related | 教材→课程图谱 |
| experimental | experiment/standard/sample/indicator/instrument/step/qc/output/difficulty | 实验课程（操作链保序） |
| industry | industry/occupation/workTask/skill/tool/trend | 产业需求侧（就业对齐） |

三图互 fuse/diff；fused 图谱节点带 `fuseMeta` 来源标记，renderStarmap 按来源侧区分渲染。

## 降级模型（能力阶梯）

`AdapterBase.invokeSkill()`：能力档案核对 → 依赖齐备 `full` → 部分缺失沿 `fallback()` 阶梯降级 `degraded` → 关键缺失 `unavailable`。原则：**绝不假装成功**——降级输出必带 `degradationNote` 说明缺什么、降成了什么。

引擎三分（`describe_capabilities` 实时探测，不硬编码）：
- `builtin`：插件内置（OCR = tesseract.js + 仓库根语言包）
- `optional-not-installed`：本机可装未装（ffmpeg → qa_media），附安装指引
- `not-provided`：官方未接（数字人/TTS/实时等 7 个特化技能），说明降级形态

## 协议

- **MCP stdio（首选）**：`server/mcp.ts` 暴露 29 个工具；tools/call 同时返回 `content` 文本通道与 `structuredContent` 结构化通道。env `NANGYING_MCP_LLM=1` 时 MCP 通道注入 LLM（默认不注入）。
- **HTTP/JSON-RPC（兼容）**：`server/http.ts` 等价接口。

## LLM 配置（三层，优先级递减）

1. **宿主注入**：宿主 agent 经 adapter 构造函数注入 provider（生产首选）
2. **`pnpm config`**：`settings/secrets.json`（gitignored，本地安全存放）
3. **`.env`**（仅本机调试）：`NANGYING_LLM_PROVIDER/MODEL/ENDPOINT` + `*_API_KEY`；MCP 通道需 `NANGYING_MCP_LLM=1` 才读取
