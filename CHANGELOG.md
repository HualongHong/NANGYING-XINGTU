# Changelog

本插件遵循"技能即契约"的迭代纪律，所有行为变更同步契约文档与 DEV_LOG。格式参照 keepachangelog 简版。

## [Unreleased]（1.8.0 预备）

R17 迭代：设置卡片——`settings_card` 技能（第 24 个共享技能）按平台政策渲染声明式设置卡片，用户可设置解码器 API key 与连接端口；密钥写入 secrets.json（0600）永不回显，端口仅 http-capable 平台开放。

### Added

- **`settings_card` 设置卡片（第 24 个共享技能）**：三阶段——`render` 按平台政策渲染声明式卡片（sections/fields/kind/required/default/policy，`apiKey` 字段 `secret: true` 要求宿主密码输入且不落日志）；`apply` 校验并写入 settings.json（644）/secrets.json（0600），返回只含后 4 位指纹；`status` 脱敏回显当前配置。平台政策矩阵 `core/config/settingsCard.ts`（源自各平台 profile.json 事实）：六 agent 平台（dsh/kimi/trae/codex/workbuddy/qoder）经 MCP stdio 接入 → 端口区块隐藏（hiddenReason 注明），宿主注入 LLM → apiKey 可留空；local 自托管 → 端口可见（默认 7379，1-65535）；未识别平台走 generic 保守政策。`apply` 硬校验：provider 枚举/endpoint http(s) URL/port 越界/stdio 平台拒收 port 一律 INVALID_INPUT 拒写入；`SkillContext` 新增 `platform` 由 `registerSharedSkills` 从适配器 profile 注入。
- **HTTP 端口联动**：`server/http.ts` 直接运行入口端口优先级 `PORT > settings.json extra.port > 7379`——卡片设置的端口重启即生效。
- **技能速查表补全**：`docs/SKILLS.md` 补齐此前缺失的全部共享技能行（fuse/diff/manage_async_tasks/describe_capabilities/assessment/audit/polish/sync_bilingual/qa_media/render_preview/industry/link）并加入 settings_card 行。

R14 迭代：handout-docx 表格格子级 API。测试 438 → 441。
迁移整理迭代：OCR 语言包迁至 `tessdata/`（兼容仓库根旧部署）；开发过程文档（DEV_LOG/HANDOVER/feedback/scratch）归集 `docs/dev/`（不入库）。测试保持 441。
R15 迭代：六平台适配器——TRAE 更名写实、WorkBuddy/QoDER 新增、kimi 声明 KimiWORK 覆盖，平台接线归一化为声明式工厂。测试 441 → 442。
R16 迭代：反馈闭环——`submit_feedback` 技能（默认脱敏 + 审阅门 + 显式敏感通道）+ 编程端 loop engineering（指标/门槛/CI 强制）。测试 442 → 464。
R17 迭代：设置卡片——`settings_card` 技能按平台政策渲染 API key/连接端口设置卡片（六 agent 平台端口自动隐藏、密钥永不回显）。测试 464 → 471。
R18 迭代：OpenDataLab 体系对接——`adapters/odlab/` 对接层（MinerU 双档解析 + SciVerse 学术证据技能 + DianShi/数据集预留位），新共享技能 `enrich_knowledge_evidence`。测试 471 → 493。

### Added

- **OpenDataLab 体系对接层 `adapters/odlab/`**：统一签名（keyProvider 惰性取钥 + fetchImpl/SDK 可注入 + redact 脱敏 + 超时），平台矩阵文档标注 Tier——MinerU/SciVerse 实装，DianShi（化学反应检索与逆合成 RAG，按账号权限申请）与 OpenDataLab 数据集为预留接入点，Sci-Evo 为观察位。
- **MinerU 云端解析解码器**（`odlab/mineru.ts`，工厂注册 `provider="mineru"`）：双模式——免 key 免费档（`/api/v1/agent/parse/file`，≤10MB/20 页仅 Markdown，超限拒绝并提示）；Token 精准档（`/api/v4/extract/task` 异步上传→轮询→zip，内置 zip 中央目录解析取 full.md）。走 `parse_course_material` 解码阶梯③号位，平台失败自动回落本地链路（独立性）。
- **学术证据增强 `enrich_knowledge_evidence`**（第 25 个共享技能）：graph（取 kind=concept 节点的 label）或 queries 二选一 → SciVerse 逐实体检索 → 归一化 `academicEvidence` 不可变合并回图谱（agentic=语义证据段 / meta=venue/year/doi 书目字段）；topK 1-10、查询数上限 20（平台额度保护）。平台不可用（无 Token/SDK 未装/限流）→ `degraded` 原样回传输入——主流程不中断，证据可后补。
- **官方 `sciverse` npm SDK 接入**（optionalDependencies + 动态 import，缺装不阻断）：上游 dist 缺 ESM 扩展名致 Node 无法导入，经 `pnpm.patchedDependencies` 补丁修复（`patches/sciverse@1.0.1.patch` 入库，新装自动生效）；密钥显式注入（SDK 推荐的 vault 模式），`.env` 的 `SCIVERSE_API_TOKEN` 为原生调试通道。
- **命名多密钥**：`secrets.json` 支持 `{ apiKey, sciverseApiKey }`（`readApiKey/writeApiKey/clearApiKey` 加 name 参数，缺省 'apiKey' 与旧文件兼容）；settings_card 新增"学术证据"区块（sciverseApiKey 可单独设置、status 脱敏回显），provider 枚举加 `mineru`；`.env.example` 加 `MINERU_API_TOKEN`/`SCIVERSE_API_TOKEN` 空占位。

### Changed

- **平台适配器目录判定**：validate.mjs 与 adapterProfile 三方一致测试改为"含 profile.json 才算平台适配器"——`adapters/odlab/` 对接层不再被误判为平台。
- **文档**：README（32 技能=25+7、目录树加 odlab、解码供应商加 MinerU）、docs/SKILLS.md（补 enrich 行）、docs/USAGE.md（供应商/命名密钥/学术证据）、docs/RECIPES.md 配方 1 加可选证据分支、dev-docs/ARCHITECTURE.md 基线。
文档收敛迭代：`docs/` 只留用户文档（SKILLS/USAGE/RECIPES）；开发过程文档（ARCHITECTURE/PLAN/VERIFICATION_CASE/LOOP_ENGINEERING 与原 `docs/dev/*`）归集本地 `dev-docs/`（gitignored，不入库）。测试保持 464。

### Added

- **`submit_feedback` 反馈协调技能（第 23 个共享技能）**：两阶段——`prepare` 生成默认脱敏的反馈草稿（**绝不入库**）→ 用户审阅 → `approve` 且 `approved=true` 才存储至 `.nangying-feedback/`（gitignored）；未审阅通过一律拒绝储存。反馈类型覆盖安装问题/使用问题/满意执行（`praise`，含未用插件场景 `not_used`）/改进建议。`includeSensitive=true` 为显式敏感通道：用户明确命令提供的片段以「敏感附件」段原样入库（标记请勿外传），未开启则默认忽略。
- **脱敏引擎 `core/feedback/sanitize.ts`**：确定性纯函数，覆盖 API key（sk-/32+令牌/AWS/GitHub/Bearer）、邮箱、IPv4、用户目录绝对路径（Unix/Windows）、.env 敏感赋值、超长随机串；输出替换文本 + 脱敏清单；`approve` 阶段对审阅编辑内容二次脱敏兜底。
- **反馈存储 `adapters/core/feedbackStore.ts`**：`accepted/<docId>.json` 全文 + `index.jsonl` 索引（含 `hasSensitive`/`consumed` 标记），支持 `NANGYING_FEEDBACK_DIR` 覆盖（测试隔离）。
- **loop engineering（编程端自我革新机制）**：`scripts/feedback-loop.mjs` 计算自我监控指标（分类分布/敏感附件占比/未消化问题数/最老滞留天数），对 `manifests/loop.thresholds.json` 门槛求值，样本量达标后超阈 exit 1——**先闭环反馈再开发**；`--consume <docId>` 标记消化；`--json` 供工具消费。已接入 `scripts/ci.mjs`（GitHub CI 空库安全通过）。机制文档 `dev-docs/LOOP_ENGINEERING.md`：捕获→脱敏→审阅门→入库→指标→开发门槛→迭代，含迭代准入清单与 praise 转回归金标规则。

### Added

- **WorkBuddy / QoDER 平台适配器**：`adapters/workbuddy`、`adapters/qoder`，保守能力档案（unknown 置信度待平台方逐项确认回填，与 dsh 同型）；`profile.json 未加载成功时回退保守默认`的行为由共享工厂保证。
- **TRAE 平台适配器（tare 更名）**：`adapters/tare/` 更名为 `adapters/trae/`（字节跳动 Trae AI IDE），profile 按公开产品资料写实——LLM/流式 confirmed、无数字人/TTS/视频 confirmed；`unknown` 置信度白名单从 dsh/tare 收窄为 dsh/workbuddy/qoder。
- **kimi 适配器声明 KimiWORK 覆盖**：profile notes 明确覆盖 Kimi Code CLI 与 KimiWORK 宿主。
- **`adapters/core/platformAdapter.ts` 声明式工厂**：`createPlatformAdapter({ platform, available, degradationPlan })` 一处解析 profile.json 路径与保守回退；profile.json 加载、能力核对、降级阶梯全部共享 AdapterBase——六个平台适配器文件各约 10 行声明、零行为自研。
- **平台清单三方一致测试**：`manifest.adapters ↔ adapters/ 目录 ↔ 测试平台清单` 强制一致（validate.mjs (c) 的 vitest 镜像，漂移即红）。

### Changed

- **OCR 语言包目录**：`chi_sim/eng.traineddata` 由仓库根迁至 `tessdata/`；`resolveOcrLangPath` 优先 `tessdata/`、回退仓库根（旧部署兼容）；`describe_capabilities` 安装指引同步。根目录不再散落二进制语言包。
- **开发过程文档归集**：`DEV_LOG.md`、`HANDOVER.md`、`feedback/`、`scratch/` 移入 `docs/dev/`（仍全部 gitignored，随文件夹迁移但不入库）；pre-commit 钩子与 .gitignore 规则同步收敛为 `docs/dev/` 一条。
- **文档边界收敛（二次）**：`docs/` 仅保留用户文档（SKILLS/USAGE/RECIPES）；ARCHITECTURE/PLAN/VERIFICATION_CASE/LOOP_ENGINEERING 与上述 `docs/dev/*` 全部移入本地 `dev-docs/`（gitignored，不入库）；README 目录树与链接、pre-commit 禁则、.gitignore 同步收敛。
- **平台适配器接线归一化**：dsh/kimi/codex 三个手写适配器类改为工厂声明（`available`/`degradationPlan` 数据原样保留，行为不变）；USAGE「新增平台适配器」章节改为工厂配方（建目录 → profile.json → 一行声明 → manifest 登记 → 测试登记）。

### Added

- **handout-docx 表格合并单元格（R14）**：`ooxmlRender` 新增格子级 API `OoxmlCell { text, colSpan?, rowSpan?, align? }`（与 pdfRender 的 PdfCell 同构）+ 通用 `wTable(rows)` 构建器——colSpan → `w:gridSpan`、rowSpan → `w:vMerge`（首格 restart，覆盖格空 tc + vMerge continue，Word 校验要求覆盖格保留 tc 标签；同行 gridSpan 覆盖位不输出 tc）、align=center → 段落 `w:jc`。`buildHandoutDocxParts` 新增第三参 `extraTables`，分镜固定表格改走 wTable；export_course_package 新增 `handoutTables` 输入（executor 透传），追加在分镜表之后。无 span 纯字符串行为**逐字节不变**（sha256 快照锁定，与 git HEAD 同输入实测一致）。真实 docx zip 经 render_preview 读回验证。

## [1.7.0] - 2026-11-07

R10 迭代：xlsx 真实导出 + 词面层句子级共现窗口。测试 410 → 419。
R11 迭代：星图多图谱类型渲染 + qa_media 渐变画面场景阈值自适应。测试 419 → 427。
R12 迭代：starmap 产物推送点修复 + fuse 实体融合来源标记。测试 427 → 433。
R13 迭代：handout-pdf 表格合并单元格。测试 433 → 438。

### Added

- **handout-pdf 表格合并单元格（R13）**：`buildPdf` 表格格子升级为 `{ text, colSpan?, rowSpan?, align? }`（纯字符串格子向后兼容）——span 网格按 anchor 分段画线框，合并区边界线不穿越；文本在合并区水平左/居中（align）+ 垂直居中；无 span 输入走旧渲染路径**逐字节不变**（sha256 快照锁定，并与 git HEAD 旧实现实测一致）。
- **starmap-svg/starmap-html 产物推送点（R12-1，真 bug 修复）**：此前 ALL_FORMATS 声明了这两个格式却没有任何产物——formats 含 starmap-svg/starmap-html 且给 `graph` 时，export_course_package 现推送真实 `starmap/starmap.svg`（R11 renderStarmap，四类型自动识别）与 `starmap/index.html`（自包含内联 SVG）；内存包/outputPath 落盘/writtenFiles 与既有格式同一通路（R10 的 append 修复不回退）；缺 graph 跳过并诚实注明。
- **fuse 实体来源标记（R12-2）**：fuse_knowledge_graphs 输出实体带 `fuseMeta: { primarySource, mergedSources }`（主来源=规范标签首次出现来源；归并来源全集确定性序）——不与实体既有 `source`（章节/段落出处）语义冲突；renderStarmap 融合图来源区分改用 fuseMeta 优先（旧 source/posting 推断兜底）。
- **export `xlsx`（R10-1）**：`export_course_package` 新增零依赖 xlsx 真实写出——`core/course/xlsxRender.ts` 手写 stored zip（[Content_Types].xml/_rels/workbook+styles/sheetN.xml），inlineStr 单元格（不建 sharedStrings）+ dimension，多 sheet，固定时间戳确定性字节；实用形态=产教分析包三表（`linkReportToTables`：matched 关联 / gaps 缺口 / coverage 冗余，取自 #29 link_knowledge_industry 输出），通用形态=`tables`（`{ name?, header, rows }` 数组）；formats 含 `xlsx` 时由适配层剥离消费（与 handout-pdf 同款），配 `outXlsx`/`outputPath`（缺省写 `tables.xlsx`）；缺 tables 与 linkReport 抛结构化错误 `EXPORT_XLSX_NO_TABLES`。真实 zip 经 render_preview xlsx 分支读回验证（互操作）。

- **export `xlsx`（R10-1）**：`export_course_package` 新增零依赖 xlsx 真实写出——`core/course/xlsxRender.ts` 手写 stored zip（[Content_Types].xml/_rels/workbook+styles/sheetN.xml），inlineStr 单元格（不建 sharedStrings）+ dimension，多 sheet，固定时间戳确定性字节；实用形态=产教分析包三表（`linkReportToTables`：matched 关联 / gaps 缺口 / coverage 冗余，取自 #29 link_knowledge_industry 输出），通用形态=`tables`（`{ name?, header, rows }` 数组）；formats 含 `xlsx` 时由适配层剥离消费（与 handout-pdf 同款），配 `outXlsx`/`outputPath`（缺省写 `tables.xlsx`）；缺 tables 与 linkReport 抛结构化错误 `EXPORT_XLSX_NO_TABLES`。真实 zip 经 render_preview xlsx 分支读回验证（互操作）。
- **`lexicalWindow` 共现窗口（R10-2）**：build_industry_graph text 形态词面路径改句子级共现建边——岗位与技能/任务须同句（`lexicalWindow=0` 缺省）或相邻句（最大 3）共现才建边，边权重=共现句数；`lexicalIndustryCooccur` 独立导出；共现为空回退旧平铺全连接；LLM 层不受影响。
- **星图多图谱类型识别（R11-1）**：`renderStarmap` 增加 `detectStarmapKind`——graphType 标记优先、nodeType/type 推断（experimental 八类实体分区环带，step_order 保持操作链弧形连边；industry 六类本体分区环带，五类关系各自线型：实线/虚线/点线/点划/长划；fused 混合图产业侧橙色虚线边框区分课程侧 + 来源图例利用 node.source）；三类均带图例（类型中文名 + 计数，产业附线型样例）。conceptual 路径逐字节不变（sha256 快照锁定，此前 experimental 图谱喂入会抛 TypeError、industry 静默丢边）。
- **qa_media 场景阈值自适应（R11-2）**：首轮 `gt(scene,0.3)` 未命中时按 0.15/0.05 复扫（`SCENE_THRESHOLD_LADDER`），报告新增 `sceneScan: { thresholdUsed, rescanned }` + low 级 `scene_threshold_fallback` finding 注明降级阈值；全阶梯为零诚实报告"该素材未检出显著场景切换（或全程渐变）……不伪造关键帧"。修复渐变画面（低 luma 帧间差素材）完全检不出切换的问题。

### Changed

- **link heat 权重感知**（R10）：`occupationDemand` 改权重映射（边权重=共现句数；同岗位多路径取 max 防重复计权），gaps heat=关联岗位边权重和；sections 形态边权恒 1，既有语义保持（GLP heat=2 断言不变）。
- 技能捕获正则允许空格（JD 常见"熟悉 GLP 规范"此前漏抓）；孤儿技能/任务挂根产业节点保持图连通（R10）。

## [1.6.0] - 2026-11-07

R9 产教图谱迭代：知识点 ↔ 产业需求。技能 27 → 29，测试 397 → 410。

### Added

- **技能 #28 `build_industry_graph`（产业图谱）**：产教图谱第三张图谱（graphType 本体 industry/occupation/workTask/skill/tool/trend + 五类关系），输出沿用 extract 骨架（stats.byType/schemaVersion/确定性 ID），fuse/diff/render_preview 直接兼容；输入双形态：sections+fields（键名 fieldMap 归一）与 JD 自由文本（LLM 抽取，词面启发式回落 degraded：岗位词典后缀 + 熟悉/掌握→skill、负责/承担→task 模式）。
- **技能 #29 `link_knowledge_industry`（产教关联）**：三层机制——词面层（精确/包含/bigram 重叠，确定性，永远可用）、LLM 语义层（逐对打分 + 理由 + 证据句，maxLinksPerNode 扇出，失败回落词面层诚实标注）、聚合层（gaps 供需缺口按岗位热度 heat 排序 + "建议补充教学点"、coverage 冗余提示、matched 溯源清单）；courseGraph 兼容 conceptual/experimental 两种实体字段名；jobPostings 现场抽取补充产业侧实体（去重合并）。
- **recommend_learning_path 增强**：可选 `targetOccupation` + `industryGraph`——以岗位 required skill 的缺口倒排学习优先级（缺口先修概念前移，note 报告覆盖/缺口项数）；缺省行为逐字节不变（测试锁定）。

### Changed

- `EdgeType` 放宽含产业关系词表；`KnowledgeGraphNode.nodeType`/`CourseKnowledgeGraph.stats` 可选字段；README/SKILLS/USAGE/计数同步 29 技能。

> 注：1.1.0–1.5.0 条目为 2026-11-07 仓库恢复时的忠实浓缩（原详细条目随源码树丢失，内容要点依据发布标签说明与 DEV_LOG 重建）。

## [1.5.0] - 2026-10-22

依据 2026-10-21 三份实测反馈的 R7+R8 迭代。技能 23 → 27，测试 → 397。

### Added

- **技能 #24 `polish_teaching_text`（文本润色）**：去机器味——套话模式表（可追加）、滑窗重复词、句长均衡、连接词多样性；LLM 逐句改写建议（术语保护 + 改动幅度约束）；无 LLM 诚实 degraded。
- **技能 #25 `sync_bilingual`（双语同步）**：中文零改动为锚，逐段对齐译文 + 术语锁定一致性检查；translate 模式复用 translate_multilingual 术语库机制。
- **export `handout-pdf`**：零依赖 PDF 直出——TTF/TTC 解析 + 中文字体嵌入（fontPath/系统探测，无字体诚实降级为拉丁 PDF + degraded）；**R8-3 字体子集化**（<30% 字符集时 glyf/cmap/loca/hmtx 重建，msyh 场景 19.7MB→647KB，确定性字节）。
- **技能 #26 `qa_media`（媒体验收门禁）**：ffmpeg 引擎门控——ffprobe 元数据、场景切换关键帧、静音段占比、SRT 时间轴静态检查（回绕/重叠/静默间隔）；无引擎诚实降级 + 安装指引。
- **技能 #27 `render_preview`（版面预览）**：docx 大纲/表格统计、pptx 每页要点、pdf 文本层判定、xlsx 行列；**扩展名与内容不符显著标注**（contentMismatch + degraded）。
- **MCP structuredContent**：tools/call 同时带 structuredContent（MCP 标准字段），调用方免二次 JSON.parse。

## [1.4.0] - 2026-10-22

R5+R6 迭代（反馈 20261021）。技能 20 → 23，测试 324 → 364。

### Added

- **扫描件 OCR 结构化摄取（R5-1）**：`ocr` 选项 + 自动探测（ocrAuto:true）；护栏（20MB/60 页/并发 2/单页 90s）；页码锚点（paragraph.page/source:"ocr"）；meta.ocr。
- **原生 PDF 文本层抽取（R6）**：零依赖对象扫描 + ObjStm + ToUnicode CMap；文本层优先完全跳过 OCR（修复幻灯片 PDF 误判 OCR 产乱码）；真实验证 8 份课程 PDF 全面成功。
- **async 显式化**：async/progress 进注册表；manage_async_tasks cleanup/gc；30s 软阈值建议；分段计时修 interrupted 脏数据。
- **图谱导出格式**：mermaid/graphml/csv/jsonld（确定性纯函数）。
- **引擎状态三分**（describe_capabilities）：builtin / optional-not-installed（安装指引）/ not-provided。
- **P2 小项**：outputPath 落盘、实体 formula（LaTeX）、freeTextReport 段落级反馈、directoryTemplate。

## [1.3.0] - 2026-10-22

R3+R4 迭代（反馈 20261021）。技能 19 → 20 → 23，测试 259 → 324。

### Added

- **契约单一源（R1）**：技能 md「输入声明」YAML 段 → gen-registry 生成注册表 → validate 三方一致；别名归一化（knowledgeGraph→graph 等）+ 字符串 JSON.parse；MCP schema 真实类型 + oneOf；错误码体系（INVALID_INPUT/INTERNAL_ERROR + requiredInputs + example）；技能 #21 `describe_capabilities`。
- **稳定性（R2）**：workspaceRoot 相对路径；docx 原生文本解码；20MB 大文件守卫；资产默认落盘 + export op；异步任务卫生（interrupted 冻结/24h 清理）。
- **质量（R3）**：LLM 过滤启用阈值锁定；实体 source/confidence + 边 provenance + schemaVersion 1.2；表格保真 tables[]；design priorKnowledge/courseType/deliverables；script sourceText/coverage；parse normalize/language/glossary。
- **新能力（R4）**：experimental 实验型图谱；#22 `generate_assessment` 图谱命题；DOCX/PPTX 写出（handout-docx/slides-pptx + outDocx/outPptx）；#23 `audit_consistency` 跨材料一致性核查。

## [1.2.0] - 2026-10-21

首个反馈驱动迭代（R1+R2 基础层），详见 1.3.0/1.4.0 条目（1.2.0 与 1.3.0 同源分批发布）。

## [1.1.0] - 2026-10-05

### Added

- **DSH Desktop 对话式安装**：`scripts/install-dsh.mjs`（体检/安装/preset/LLM 配置/OCR 预热/--check/--uninstall）。
- **异步任务 + 轮询模式（#20 manage_async_tasks）**：作业注册表 + 磁盘快照（重启恢复、24h 保留）；parse/extract/fuse/translate 支持 async:true；setImmediate 延迟启动修复"提交响应 86s"。
- **LLM 过滤批并发池**：并发 4 + 进度回报（progress 通知 + stderr）+ 总预算 12 分钟兜底。

### Fixed

- extract 坏输入崩溃（输入防御层 + core 形态守卫）；MCP server 默认关闭 .env LLM 自动注入（NANGYING_MCP_LLM=1 opt-in）；llmFromEnv 120s AbortSignal 超时。

## [1.0.0] - 2026-10-05

首个正式版：19 个技能全部实现并注册，全链路（parse → 图谱 → 融合/比对 → 结构 → 脚本 → 导出）经真实 LLM 注入验收。

### 技能（19/19）

- **共享 12**：parse_course_material、extract_knowledge_graph、fuse_knowledge_graphs、diff_knowledge_graphs、design_course_structure、generate_teaching_script、translate_multilingual、build_qa_knowledge_base、recommend_learning_path、generate_personalized_feedback、export_course_package、manage_course_assets
- **特化 7（降级实现）**：register_teacher_avatar、synthesize_speech、generate_digital_human_video、orchestrate_multi_teacher、match_teaching_scene、sync_multilingual_av、realtime_qa_stream
