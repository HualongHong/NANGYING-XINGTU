# Changelog

本插件遵循"技能即契约"的迭代纪律，所有行为变更同步契约文档与 DEV_LOG。格式参照 keepachangelog 简版。

## [1.8.1] - 2026-11-23

GitHub CI 首次转绿——历史 23+ run 全红系四层叠加根因，逐层解剖修复：

### Fixed

- **CI 第一层（pnpm 版本错配）**：lockfile 由 pnpm 12 生成（`patchedDependencies` 内容哈希形态），workflow 用 pnpm 10（路径形态）→ `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` 安装即败。`pnpm/action-setup` version 10 → 12.18.0。
- **CI 第二层（allowBuilds 占位值）**：`pnpm-workspace.yaml` 的 `allowBuilds` 键名本是 pnpm 12 正解（`pnpm approve-builds --all` 回写证实），但值为脚手架占位串 `'set this to true or false'` 而非 `true`，构建脚本审批从未生效；CI 模式（CI=true）下被忽略 build scripts 是硬错误 `ERR_PNPM_IGNORED_BUILDS`。改为三包显式 true（esbuild/sharp/tesseract.js 脚本均本地无网络操作）。顺带撤 `setup-node` 的 pnpm store 缓存（失败期缓存元数据会重致安装误判）。
- **CI 第三层（tessdata 缺席）**：`scannedOcr`/`engineStatus` 测试按"真实探测不硬编码"要求仓库根 `tessdata/`（chi_sim+eng），但 traineddata 按 .gitignore 不入库 → `resolveOcrLangPath` 返回 null、OCR 引擎 `optional-not-installed`。workflow 增"准备 OCR 语言包"步骤：tessdata_fast@main 拉取 + sha256 钉死（chi_sim a5fcb6f0… 与本地同源已验证；eng 以 main 7d4322bd… 为准）。
- **CI 第四层（dist 未构建）**：`tests/installDoctor.test.ts` 动态 import `scripts/install-dsh.mjs`，其静态 import `../dist/adapters/core/configStore.js`；dist/ gitignored 且 CI 从不构建 → vitest 10 秒速败（Failed to load url）。workflow 类型检查后增 `pnpm run build`；`scripts/ci.mjs` 同步插构建步（fresh clone 本地 `pnpm run ci` 不再隐性依赖残留 dist）。
- **CI 可观测性**：校验/类型检查/测试分步（失败步即注解）；测试步失败时 grep 过滤（FAIL/×/Error）回注 `::error::` 注解——无日志匿名权限下可读真实错误（本轮定位全靠此通道）。

## [1.8.0] - 2026-11-18

R22 迭代：多平台上架分发——按 KimiWORK / Qoder / DSH / WorkBuddy / TRAE 五个目标平台的上架标准，新增共享打包器 `scripts/pack-release.mjs`，从单一事实源（技能契约 + meta + plugin.manifest）生成 `release/` 五分发产物（gitignored，随 Release 附件分发）。产物经 16 例结构测试锁定 + 敏感信息扫描 + SHA256SUMS 对账；产物内 runtime 冒烟通过（38 工具全列）。

### Added

- **`scripts/pack-release.mjs` 分发打包器**（`pnpm run pack:release`）：技能 SKILL.md 统一生成（frontmatter name/description + 契约正文）；按平台规则转换技能命名（kimiwork=snake / qoder·dsh·workbuddy=kebab，DSH 技能名 `[a-z0-9-]+` 铁律）；五配方命令（recipe-1~5）kimiwork/qoder 共享；kimiwork/qoder/trae 内嵌 runtime（dist 拷贝，stdio MCP 38 工具，Node ≥ 20，可选引擎缺失自动降级）；dsh 包附 preset 交付块（与 `install-dsh.mjs --with-preset` 同源）；workbuddy 标准两层市场布局（marketplace.json + plugins/<name>/）；trae 按现行能力以 MCP+规则分发（mcp.json + rules/ + 38 篇参考文档）。内置敏感信息扫描（私钥/AWS AK/sk- 前缀/硬编码凭证）命中即中止。
- **`tests/releasePack.test.ts` 产物结构守卫（16 例）**：五平台清单存在性与字段规则（kimi 根清单/name 正则、qoder manifest 不在根、DSH preset 块、workbuddy 两层布局、trae mcp+rules）；38 技能全平台齐备 + frontmatter 校验 + snake↔kebab 映射无损；配方命令 5 个；LICENSE/README 齐备；SHA256SUMS 与文件一一对应；敏感扫描通过。
- **`docs/RELEASE.md` 发布手册**：五平台上架标准对照表、构建/安装指引、MCP runtime 说明、发布检查单。

R20 迭代：科教融合备课工作流——由真实备课实践（基础生态学 4 轮 / 土壤学 7 轮，经验沉淀于 dev-docs/feedback/20261115，本地不入库）蒸馏出 5 个新共享技能，组成「章节 + 会议摘要集 → 四件套」全链：需求治理 → 摘要集解析 → 研究例证选文 → 四件套组装 → 教学包验收。纯本地零密钥，无 LLM 可跑通（降级骨架 + 诚实占位）。测试 506 → 559。

### Added

- **`gather_teaching_requirements` 教学需求治理（第 27 个共享技能）**：开工必问 Q1–Q8 校验与三档停工判定（Q1–Q3 缺则硬停工不编造 / Q4 默认须复述 / Q5–Q8 逐项问不预设）；H/P 约束分层（auto 信号判定，拿不准归 P）与约束登记表（附录 B 字段，「纠偏即登记」）；迭代场景「沿用并复述」（carriedOver/confirmedCarryOver）与口径变更标注（changed）。`core/course/gatherTeachingRequirements.ts` 纯判定零 IO。
- **`parse_abstract_collection` 摘要集解析（第 28 个共享技能）**：分页文本（pdftotext 直出，`\f` 自动切段）→ 结构化记录（题名/作者/单位/关键词/正文/分会场/物理页+印刷页）；**页号偏移 Δ 自动探测**（恒值/罗马前言分段/样本不足 unavailable——不写死偏移量）；entryPattern 条目切分（编号前缀剥离）或预切分归一化；抽取缺陷旗标（title_eats_author/cross_page_break/keywords_in_body/affiliation_missing/title_missing）；解析覆盖率（差额如实报告不强行补齐）。独立页码行剥离防正文污染。
- **`select_research_evidence` 研究例证选文（第 29 个共享技能）**：词族命中加权评分（题名>关键词>正文>单位，权重可配建议值）、**相对分位阈值**（非绝对分数线）、排除词降权留痕、题名规范化去重（簇内保留高分）、覆盖面约束优先（每节至少 k 条，低于阈值补入标 mustReview）、收敛四条件（重点覆盖/节落位/无重复/来源齐全，不凑数下限）、落选理由 + 复核记录表（附录 F）。词族缺省启发式直取（core=知识点标签），ctx.llm 在场自动派生并入（失败回落并标注）。
- **`compose_teaching_artifacts` 教学四件套组装（第 30 个共享技能）**：选文源+课程结构+教师数据层 → 四件套内容源；**编号单一来源**（案例编号=阅读编号、按课程节顺序，方法论 3.10 口径）；来源字段统一模板渲染（7.3：`[阅读编号 NN] 作者. 题名. 会议, 年份: 印刷页 P（分会场；PDF 第 P+Δ 页）. 链接或 DOI：未提供.`，缺失一律未提供不补造）；H1 学生/教师信息边界校验（教师 token 命中学生产物即违规列出）；增量加工基线 diff（A4 不破坏已验收指标）。正文 agent 按层撰写，骨架可空但占位诚实。
- **`audit_teaching_package` 教学包验收（第 31 个共享技能）**：C1–C8 验收链的纯检查侧——零外链模式集（豁免内联 SVG `url(#id)`/`data:`）、学生可见禁用词=0（教案不受约束）、未定稿占位符扫描、跨产物编号覆盖/多余/顺序比对、来源字段「未提供/DOI」口径、原文/解读奇偶配对（双面印发相邻）；编译日志/写盘核验/打印态/定稿同步为 delegated 判项 + 程序指引（验证阶梯、bbox≥5pt 安全线、F08/F09 陷阱）；输出**红线触发清单**（M 章编号），触发即停下向用户确认。passed 只统计已执行判项（未验证不冒充通过）。
- **配方与文档**：`docs/RECIPES.md` 新增配方 5（科教融合四件套工作流：调用序列 + 预期产物 + 4 条常见坑）；`docs/USAGE.md` 配置章补五技能链说明；README/SKILLS/ARCHITECTURE 计数与目录同步（26→31 共享，33→38 总数）。
- **反馈闭环联动（文档级）**：验收 fail 项与红线触发经 `submit_feedback`（usage_issue/suggestion）入库，供 loop engineering 指标监控；本迭代不改反馈代码。

R21 迭代：examples/ 示例即活文档——配方 5 全链 + 配方 1 前半链 + 配方 2 链 + 配方 3 链端到端守卫 + 示例摘要集版式修正为真 Δ=1；配方 5 两技能补 `async` 异步作业；MinerU 适配器按官方现行契约重写（签名上传两段式）。测试 566 → 589。

### Fixed

- **MinerU 适配器契约漂移修复**：真实健康检查发现官方已废弃 multipart 文件直传——免费档 400 `field "file_name" is not set`（现为 JSON 申请签名上传 URL → OSS PUT → 轮询 → Markdown CDN 两段式）；精准档 `/api/v4/extract/task` 不再收文件（改为 `/api/v4/file-urls/batch` 批量上传通道 batch=1 → PUT → 轮询 `/api/v4/extract-results/batch/{id}` → zip）。`mineru.ts` 两档全量重写：新增信封业务错误识别（HTTP 200 + code≠0，如 -60009 队列已满）、err_code 结构化抛出、PUT 直传件；测试 mock 同步新版契约并补免费档 failed/业务错误用例。**真机端到端验证通过**（手构 603B 单页 PDF → 免费档返回正确 Markdown；扫描版 PDF 内嵌文字图 → rung③ OCR 返回正文；xlsx → Office 原生解析返回表格）。OpenDataLab 数据集探查实机同验通过（GAOKAO-Bench/MMLU 匿名 full）；SciVerse 因 .env 无 Token 未验。
- **xlsx 课件解析链开通**：`BINARY_MATERIAL_TYPES` 与 core `KNOWN_TYPES` 增 `xlsx`——Excel 课件经二进制解码链到配置位③ MinerU 免费档 Office 原生解析（本地无 xlsx 原生抽取，MinerU 是唯一通道；平台不可用时按既有阶梯降级并注明）。`parse_course_material` 契约 hint 同步。
- **validate.mjs 增 SKILLS.md 速查表完整性校验 (g)**：注册表 38 技能 ↔ docs/SKILLS.md 表格行一一对应（缺行/多出行即红），速查表漂移自此 CI 可查。
- **DSH preset 与安装脚本漂移修正**：preset 描述/persona 的"19 个技能"→38、"四个配方"→五个，persona 补配方 5 五链与按需启用四技能（settings_card/submit_feedback/inspect_teaching_dataset/enrich_knowledge_evidence）；install-dsh.mjs 提示语改读注册表动态计数（`registrySkillCount()`），不再硬编码。
- **validate.mjs 增 DSH preset 漂移校验 (h)**：preset 声称技能数（阿拉伯数字）与配方数（中文数字）分别对账注册表与 RECIPES.md，漂移即红（正反两向验证）。
- **tsconfig.build.json 补 cli/****：`pnpm run build` 此前不产出 `dist/cli/config.js` 而 `pnpm config` 与文档命令都指向它（新鲜克隆构建后 CLI 即坏）——include 增 `cli/**/*.ts` 根治；CLI 全通道冒烟通过（写入 0600 脱敏/回显/清除/空值拒写/未知供应商拒写）。
- **validate.mjs 增 dist 引用漂移校验 (i)**：package.json 脚本指向的 `dist/*.js` 其源 ts 必须被 build include 覆盖（CLI 事故类自此 CI 可查，正反两向验证）。
- **配置双占用冲突修复（setup-llm × 解码器配置）**：settings.json 顶层 provider 是解码器枚举，而 setup-llm 向导把 LLM provider（deepseek/minimax）写同一位 —— 覆盖既有解码器配置且被阶梯③当未知供应商。现 LLM 配置改存 `extra.llm`（setup-llm merge 写入，解码器配置与端口等 extra 字段原样保留），`createLlmFromEnv` 优先读 `extra.llm`、顶层旧配置兼读。同 bug 类全部清扫：`eval-llm-filter.mjs` 缺省回退改 extra.llm（原会把解码器 mineru 当 LLM 调）、`install-dsh --doctor` LLM 行按分位分列（解码器顶层/LLM extra.llm）、`pnpm config --show` 渲染 extra.llm 行、`.env.example` 补 MOONSHOT_API_KEY 与 `NANGYING_LLM_*` 调试三件套。顺带修复同类缺口：解码器工厂补 `local-ocr` 分支（settings_card/CLI 枚举早已允许，工厂缺失会导致配置即坏）；阶梯③对非解码器 provider 从"抛未知供应商"改为"跳过并给清晰注释"。

### Added

- **`tests/examplesWalkthrough.test.ts` 端到端演练守卫**：仓库自带示例（CC0）× 四条配方链一次跑通并锁定——配方 5 五技能全链（需求治理 Q1–Q8 问齐 stopWork=false → 摘要集解析 7/7 + Δ 恒值探测 → 选文每节落位 + 收敛四条件 → 组装编号节序 + 来源口径 → 验收确定性判项全 pass 零红线）；配方 1 前半链（讲义解析 → 知识图谱实体覆盖 → 三级课程结构 → 分镜口播字幕齐备）；配方 2 链（讲义解析 → 知识图谱 → 答疑库定义/关系/流程意图 → 学习路径先修序）；配方 3 链（新增 `讲义-光合作用基础-v2.md` 修订示例：3.3 更名/删 3.4/新增 3.5 光呼吸与 CAM → 图谱 diff 新增/丢失概念量化 + 相似度）。示例即活文档：改坏任一环此测试即红，拿到仓库的人随时可复演。
- **示例摘要集版式修正**：`摘要集-青年生态学论坛.txt` 重构为真 Δ=1 版式——封面/目录独立成物理第 1 页且无页码，正文自物理第 2 页起、印刷页 1 起，与 README「Δ=1 偏移探测演示」描述一致（原先封面并入第 1 页实为 Δ=0）。
- **版本对齐**：package.json `1.5.0` → `1.8.0`，与 plugin.manifest 基线一致（历史遗留掉队）。
- **`parse_abstract_collection`/`select_research_evidence` 补 `async` 异步作业**（R21）：契约增 `async` 入参并纳入 `ASYNC_CAPABLE`——大摘要集（数百页解析）与 LLM 词族派生 + 大候选池场景可 `async: true` 提交、`manage_async_tasks` 轮询，不受宿主单次调用超时限制；异步结果与同步一致性有 jobQueue 测试锁定（records 标题序列相等）。
- **文档补强（RECIPES.md）**：文首加"可复演性"指引（examples/ 四条链 + 端到端守卫测试 + 真实 LLM 实测结论）；配方 5 常见坑补第 ⑤ 条——六个支持 `async` 的技能清单与适用场景。

R19 迭代：OpenDataLab 数据集探查——`inspect_teaching_dataset` 技能（第 26 个共享技能）探查数据集仓库元信息+文件清单并给教学相关性评分；公共仓库匿名零配置可用，AK/SK 成对解锁受限仓库。

### Added

- **`inspect_teaching_dataset` 教学数据集探查（第 26 个共享技能）**：输入 `repo`（username/repo_name）→ OpenXLab OpenAPI 元信息 + 文件清单（`maxFiles` 1-1000 截断、`prefix` 子目录、`listFiles=false` 只回元信息）→ 归一化输出 + **教学相关性启发式**（试题/教材/课件/课程关键词命中确定性评分 high/medium/low）。端点与 AK/SK→JWT 流程复刻自官方 openxlab SDK 源码（`openxlab.org.cn/datasets/api/v2/`，仓库名斜杠转逗号；`openapi.openxlab.org.cn` 的 auth→HMAC-SHA256(SK, nonce)→getJwt 挑战式鉴权，node:crypto 实现），端点可经 `extra.odlabEndpoint` 覆盖。
- **四级降级**（对应"平台不可用独立执行"）：①公共仓库**匿名可探查**（官方行为：info/list 对公开仓库无需授权）——零配置兜底；②受限仓库 401/403 → `AUTH_REQUIRED` 结构化引导配置命名密钥；③清单失败而元信息可得 → `degraded` 半量返回；④网络故障 → `PLATFORM_UNAVAILABLE`（明示不影响课程生产主流程）。
- **AK/SK 成对密钥位**：settings_card 新增"数据集探查"区块（`odlabAccessKeyId`/`odlabSecretAccessKey`，secret 标记、policy 注明成对语义与 HMAC 用途）；命名密钥落盘 secrets.json（0600），status 脱敏回显（只报后 4 位指纹）；`.env` 调试通道 `OPENXLAB_AK`/`OPENXLAB_SK`（与官方 SDK 环境变量同名）。
- **`adapters/odlab/datasets.ts`**：统一签名（ak/skProvider 惰性取钥 + fetchImpl 可注入 + redact 脱敏 + withTimeout），JWT 内存缓存（提前 60s 过期重取），401 自动鉴权重试。
- **odlab 平台矩阵升级**：OpenDataLab 数据集由 Tier 3 预留升为 Tier 1 实装；关键词"搜索"端点经核实官方 SDK 未暴露免费 HTTP 搜索接口，列为预留 seam。

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
R19 迭代：OpenDataLab 数据集探查——新共享技能 `inspect_teaching_dataset`（公共仓库匿名零配置可探查 + AK/SK 解锁受限仓库 + 四级降级）。测试 493 → 506。
R20 迭代：科教融合备课工作流——新共享技能×5（需求治理/摘要集解析/选文/四件套组装/教学包验收），章节+摘要集→四件套全链。测试 506 → 559。

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
