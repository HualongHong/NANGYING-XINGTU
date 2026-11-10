# 囊萤星图 项目规划书

> **历史文档**：本文是 2026-09-30 的 v0.1 初稿规划。现状以 [`ARCHITECTURE.md`](ARCHITECTURE.md)（v1.7.0 基线：29 技能 = 22 共享 + 7 特化降级）与 [`CHANGELOG.md`](../CHANGELOG.md) 为准；文中"17 个技能""占位待实现"等表述均为 M0 时代快照，保留作决策溯源。

- 版本：v0.1（初稿，待评审）
- 日期：2026-09-30
- 项目：囊萤星图 / Nangying StarMap（`nangying-starmap`）
- 口号：聚萤成星，一图开课。

## 1. 项目概述

囊萤星图是一个**知识图谱驱动的慕课智造与准备插件**，面向 DSH、Kimi、TARE、Codex 等多类 agent 平台。核心隐喻：零散课程材料如萤火微光，知识图谱是星图——插件把萤火聚成星图，再从星图一键开课。

**价值主张**：教师上传 PPT 与讲稿后，插件自动完成"材料解析 → 知识图谱 → 课程结构与脚本 → 多语种翻译/问答库 → 课程包导出"的全流程；数字人视频、TTS、实时问答等特化能力按平台条件启用，缺能力时自动降级，保证基础流程始终可用。

**目标用户**：
- 课程制作者 / 教师：以自然语言驱动 agent 完成慕课准备。
- agent 平台集成方：读取契约（manifest + 注册表 + 技能文档）即可接入全部技能。

**插件形态的本质判断**：本项目是"契约 + 适配层"，不是独立应用。17 个技能以 Markdown 描述 + JSON 注册表为消费入口，代码集中在 `core/`（领域逻辑）与 `adapters/`（协议对接）。任何 agent 平台无需构建本项目即可读取技能定义。

## 2. 现状盘点（M0 已完成）

初始化脚手架已落地并通过自检，首个提交 `f397fa6 chore: init nangying-starmap plugin scaffold`，工作区干净，分支 `main`。

已具备：
- 契约层：`manifests/plugin.manifest.json`、`manifests/skills.registry.json`（17 条技能记录）。
- 技能文档：17 个技能 `.md`（共享 10 + 特化 7），统一八小节格式。
- 代码骨架：`core/types.ts`（SkillDescriptor / CapabilityProfile / SkillResult / DegradationLevel）、`adapters/core/adapter.base.ts`（统一接口 + 降级阶梯）、4 个平台适配器骨架。
- 自检：`scripts/validate.mjs` 三项一致性校验，实测通过（Node v24）。
- 文档：README、ARCHITECTURE、SKILLS、USAGE。

未决事项（详见 §9）：
- 4 个平台适配器的能力档案为占位，待真实对接确认。
- `core/` 五个领域模块为空，无实际实现。
- 未安装依赖（typescript / vitest 仅声明），无测试框架。
- LICENSE 署名为占位。

## 3. 目标与成功标准

**总体目标**：到 v1.0，任意支持 MCP 的 agent 平台可通过本插件完成"材料 → 星图 → 课程脚本 → 多语版本 → 课程包"的端到端最小闭环；特化技能在缺引擎时沿降级阶梯退化为基础可用形态。

**可验证的成功标准**：
1. `node scripts/validate.mjs` 在 CI 与本地持续通过（契约不漂移）。
2. 以一份示例课程（≥20 页 PPT 讲稿）为输入，顺序调用共享技能链，产出结构化图谱、课程结构、分镜脚本、至少中英双语版本与可解压的课程包，全程无需人工补数。
3. 在模拟"无 TTS / 无数字人"能力档案下，主流程自动降级（如纯字幕、静态头像模式）且不中断。
4. 10 个共享技能的 `core/` 实现均有 Vitest 单测，核心图谱与脚本生成链路有集成测试。
5. 新增一个平台适配器的工作量 ≤ 继承基类 + 声明能力档案 + 少量协议映射（以 USAGE 文档复现为准）。

## 4. 范围界定（v1.0）

**In scope**：
- 10 个共享技能的 `core/` 真实实现（解析、图谱、结构、脚本、翻译、问答库、路径、反馈、导出、资产管理）。
- 7 个特化技能的**契约与降级实现**：默认走降级路径（纯字幕、PPT+字幕视频描述、异步问答等），真实引擎接入以适配器钩子预留。
- MCP 优先、HTTP/JSON-RPC 兼容的协议层。
- 示例课程端到端用例（含中英文）。
- `validate.mjs` 纳入 CI。

**Out of scope（v1.0 不做）**：
- 真实数字人建模、声音克隆、TTS 引擎的商业服务对接（仅留接口与降级）。
- SCORM/IMS 官方合规认证（仅保证包结构可被主流 LMS 导入）。
- 图形界面（本项目是插件，UI 由宿主平台负责）。
- 学习行为数据的持久化服务（反馈技能只定义输入输出契约与纯逻辑实现）。

## 5. 里程碑与路线图

工时为相对估算（以"人周"计），可按实际投入线性伸缩；每个里程碑结束即更新 DEV_LOG 并打 tag。

| 里程碑 | 主题 | 关键交付物 | 验收标准 | 估算 |
|---|---|---|---|---|
| M0 | 脚手架（✅ 已完成） | 契约、技能文档、适配器骨架、validate.mjs | 自检通过、首个提交入库 | — |
| M1 | 核心最小闭环 | `parse_course_material` → `extract_knowledge_graph` → `design_course_structure` → `generate_teaching_script` 的 core 实现；引入 Vitest | 示例讲稿输入 → 产出图谱 JSON + 分镜脚本，全链单测+集成测试通过；不依赖任何外部服务 | 3–4 人周 |
| M2 | 多语种与智能助学 | `translate_multilingual`（含术语库模块 `core/i18n`）、`build_qa_knowledge_base`、`recommend_learning_path`、`generate_personalized_feedback`、`manage_course_assets` | 中英双语输出术语一致；问答库可被关键词检索命中；路径推荐遵守先修拓扑 | 3–4 人周 |
| M3 | 协议层与特化降级 | MCP server 与 HTTP/JSON-RPC 入口；7 个特化技能的降级实现；4 平台能力档案确认并回填 | 在无 TTS/数字人能力档案下主流程自动降级不中断；外部 agent 经 MCP 可调用至少 3 个技能 | 2–3 人周 |
| M4 | 导出与发布 | `export_course_package`（SCORM 结构 + 视频/字幕/多语 zip）；示例课程资产；文档收尾；v1.0 tag | 课程包可被一款主流 LMS 导入；README/USAGE 与最终行为一致 | 2 人周 |

**实施顺序的依据**：共享技能按 §主流程的拓扑序实现（解析是唯一的源头，导出是唯一的汇点），保证每个里程碑结束都有一条可演示的增量链路；特化技能整体靠后，因为它们只增强不阻断主流程。

## 6. 技术决策（已定，非新提案）

- **语言/运行时**：TypeScript（ES2022 / NodeNext / strict），Node ≥ 20；包管理 pnpm（M1 首次 install 时引入 lockfile）。
- **契约优先**：技能以 md + registry 定义输入输出，代码实现必须反向服从契约；契约变更须同步更新 `plugin.manifest.json` 版本号（语义化）。
- **协议**：MCP 优先，HTTP/JSON-RPC 兼容；协议层与领域层（`core/`）严格分离，core 不 import 任何协议代码。
- **降级模型**：以 `DegradationLevel = full | degraded | unavailable` 贯穿 `SkillResult`；缺能力时由 `adapter.base.ts` 的 fallback 阶梯处理，技能实现自身不感知平台。
- **测试策略**：M1 引入 Vitest；core 纯函数单测为主，技能链用集成测试；`validate.mjs` 作为契约守门纳入 CI。
- **无外部服务依赖的底线**：共享技能链在离线/无 API key 环境必须可运行（LLM 抽取等以可注入的 provider 接口隔离，提供本地启发式降级实现）。

## 7. 质量保障

- **契约守门**：`node scripts/validate.mjs` 每次提交前必跑；M3 起接入 CI。
- **回归基准**：示例课程作为黄金样本，其各阶段产物（图谱 JSON、脚本 md、双语字幕）入库为 fixture，变更导致产物 diff 超出白名单即失败。
- **降级演练**：测试矩阵至少覆盖"全能力 / 无数字人 / 无 TTS / 无实时"四档能力档案。
- **文档同步纪律**：行为变更必须同步更新对应技能 md 与 registry，DEV_LOG 记录每个里程碑。

## 8. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 4 平台真实能力未知 | 适配器能力档案失真 | 契约先行；M3 专门安排对接确认，偏差回填 registry 与适配器 |
| 图谱抽取质量依赖 LLM | 星图错误向下游传导 | 图谱产出强制结构化校验 + 标题层级降级；示例课程人工校对一轮作为基准 |
| 多语术语漂移 | 翻译技能名存实亡 | 术语库独立为 `core/i18n` 一等模块，翻译与 TTS 共用同一术语源 |
| 外部引擎（TTS/数字人）不可控 | 演示链路中断 | 特化技能默认降级路径可演示；真实引擎仅经适配器钩子注入 |
| 范围蔓延（SCORM 合规、UI、实时协作） | 里程碑失焦 | §4 范围冻结；新增诉求先入 DEV_LOG 待办，评审后再排期 |
| 单人/小团队节奏波动 | 里程碑滑动 | 里程碑按增量链路切分，滑动时优先保 M1 闭环不断 |

## 9. 待确认决策（评审时逐项拍板）

1. **LICENSE 署名**：当前为 "Nangying StarMap Contributors" 占位，需确认项目归属主体。
2. **4 平台能力档案**：DSH / Kimi / TARE / Codex 各自是否具备数字人、TTS、实时流能力，需平台方确认后回填。
3. **M1 首技能确认**：建议从 `parse_course_material` 起步（它是唯一源头，其输出 schema 决定下游全部契约）。
4. **LLM provider 注入方式**：共享技能的抽取/生成需要 LLM 时，采用"宿主 agent 注入 provider"还是"插件内置可配置 provider"，影响 core 接口设计，建议在 M1 开工前确定。
5. **示例课程选题**：需一份可公开入库的中英素材（建议自制，避免版权风险）。

## 10. 附录

### 10.1 技能清单速览

- **共享型（10）**：parse_course_material、extract_knowledge_graph、design_course_structure、generate_teaching_script、translate_multilingual、build_qa_knowledge_base、recommend_learning_path、generate_personalized_feedback、export_course_package、manage_course_assets
- **特化型（7）**：register_teacher_avatar、generate_digital_human_video、synthesize_speech、orchestrate_multi_teacher、match_teaching_scene、sync_multilingual_av、realtime_qa_stream

详见 [SKILLS.md](SKILLS.md) 与 `manifests/skills.registry.json`。

### 10.2 主流程调用关系

```
parse_course_material → extract_knowledge_graph → design_course_structure → generate_teaching_script
        ↓ build_qa_knowledge_base        ↓ translate_multilingual → synthesize_speech
recommend_learning_path / generate_personalized_feedback（助学环）
特化技能（数字人视频/多师/场景/多语同步/实时问答）作为增强环
                              ↓ 全部汇入
                     export_course_package
```

### 10.3 工程结构

见 [README.md](../README.md) 目录结构一节与 [ARCHITECTURE.md](ARCHITECTURE.md)。
