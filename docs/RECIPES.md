# 配方（Recipes）：教学助理引导下的典型工作流

面向"DSH 里被教学助理 preset 引导"的场景：用户说一句目标，preset 按下列顺序指挥 `mcp__nangying_starmap__*` 工具完成。每个配方标注前提（LLM 配置状态的影响）、调用序列（编号 + skillId + 关键入参）、预期产物与常见坑。

> LLM 状态说明：宿主注入（正式路径）或 LLM 配置（`node scripts/install-dsh.mjs --setup-llm` 写入 settings.json 的 `extra.llm`，或历史顶层配置兼读）或 `.env`（调试）任一可用即"有 LLM"。无 LLM 时全链路仍可跑通（启发式降级），但候选过滤、译文润色、理由生成等增强缺失。注意 `pnpm config` 配置的是**文档解码器**（顶层 provider），与 LLM 配置分位存放、互不覆盖。
>
> 可复演性：仓库 `examples/` 目录自带原创 CC0 示例材料，覆盖配方 1 前半、2、3、5 四条链；`npx vitest run tests/examplesWalkthrough.test.ts` 对这些示例跑端到端守卫（12 例），改技能或改示例改坏任一环即红。配方 5 的五技能链在真实 LLM（DeepSeek）下已实测词族派生 3/3 节并入通过。

## 配方 1：PPT/课件 → 知识图谱 → 多语种课程包（主流程）

**目标**：一套课件（PPT/PDF/讲义）变成带星图的可交付多语种课程包。

**前提**：建议有 LLM（候选过滤与译文质量显著提升）；OCR 语言包（chi_sim/eng.traineddata）在 tessdata/ 目录自带（兼容仓库根旧部署），离线直读。

**调用序列**：

0. （可选）`inspect_teaching_dataset`：`{ repo: "OpenDataLab/某教学数据集", maxFiles: 100 }` → 元信息+文件清单+教学相关性评分。公共仓库匿名零配置可探查，用来给课程找试题/教材/课件类公开数据集；平台不可用直接跳过，不影响后续。
1. `parse_course_material` × N（每个材料一次）：`{ materialFile: "<路径>", options: { llmFilter: "auto" } }` → 章节/段落/候选池 + `llmFilterReport`。产物衔接：输出的 `knowledgePointCandidates`（全量候选池）要留给 fuse。
2. `extract_knowledge_graph` × N：`{ structuredContent: "$parse_course_material" }` → 单元图谱（星图中枢 schema）。
3. `fuse_knowledge_graphs`：`{ graphs: [N 个单元图谱], sources: [{id, weight}], pools: [N 个候选池] }` → 整门课融合图谱 + 归并报告（跨单元共享概念如"离心/标准曲线"在此归并）。
3.5 `enrich_knowledge_evidence`（可选，SciVerse 学术证据）：`{ graph: "$fuse", topK: 3, mode: "agentic" }` → 图谱挂 `academicEvidence`（逐概念学术引用）。SciVerse 不可用（无 Token/限流）时返回 `degraded` 且图谱原样——跳过不影响后续步骤，证据可后补重跑。
4. `design_course_structure`：`{ graph: "$fuse", objectives: { audience, totalMinutes } }` → 模块/课时/环节。
5. `generate_teaching_script`：`{ structure: "$design" }` → 分镜/口播/字幕三稿。
6. `translate_multilingual`（可选，需 LLM 才有真译文）：`{ script: "$generate", targetLanguages: ["zh","en"], glossary: <可选术语库> }` → 多语同构脚本。
7. `export_course_package`：`{ script, graph, translations, options: { formats: ["markdown","subtitles","starmap-svg","starmap-html"], outDir } }` → 课程包（含星图 SVG/HTML）。

**预期产物**：课程包目录（讲稿 md、SRT 字幕、星图、graph.json）。

**常见坑**：pools 忘记带 → 跨单元共享基础概念被 top-N 挤出（词表稀释）；多材料循环时逐步断言 `level`，`degraded` 不中断链路但要看 `degradationNote`。

## 配方 2：讲义/字幕 → 实时答疑库

**目标**：把讲义变成可检索的问答库，支撑课堂实时/异步答疑。

**调用序列**：

1. `parse_course_material`：`{ materialFile: "<讲义>" }` → 段落与候选。
2. `extract_knowledge_graph`：`{ structuredContent: "$parse" }` → 图谱。
3. `build_qa_knowledge_base`：`{ graph: "$extract", paragraphs: "$parse.paragraphs" }` → 问答对 + 倒排索引 + 意图标签。
4. `recommend_learning_path`：`{ graph: "$extract", profile: { goalConceptIds, availableMinutes } }` → 先修序学习路径（供答疑时推荐补课）。
5. （接特化）`realtime_qa_stream`：`{ question, qaKnowledgeBase: "$build_qa" }` → topK 答案（无实时通道时 degraded 为异步单轮，属正常）。

**预期产物**：问答库 JSON（可导出存档）、路径推荐。

**常见坑**：问答质量依赖段落切分——讲义 OCR 文本建议先过一遍"章节数是否合理"（碎片链已由 MRS 清零，但版面条目合并仍是已知限制）。

## 配方 3：教材版本更新 → 图谱 diff

**目标**：材料更新后，量化图谱变化（新增/丢失的知识点）。

**调用序列**：

1. （更新前）融合图谱已存档：`saveGraphSnapshot(courseId, "v1", graph)`（assetStore API，适配层）。
2. 更新材料后重跑 配方 1 的第 1–3 步 → 新融合图谱。
3. `diff_knowledge_graphs`：`{ graphA: "快照 v1", graphB: "新图谱", labelA: "v1", labelB: "v2" }` → 实体/边差集、weight 变化、三重相似度；LLM 注入时附重命名候选。

**预期产物**：diff 报告（讲义修订影响评估）。

**常见坑**：快照与重跑必须基于**同一套 sources 权重**，否则 related 边 weight 差集会放大"伪差异"。

## 配方 4：多教师数字分身协同（特化·降级说明）

**目标**：多教师分工授课的编排计划。

**调用序列**：

1. `register_teacher_avatar` × N：`{ teacherProfile, avatarMaterials }` → 分身档案（无数字人引擎时 degraded：静态头像档案，正常）。
2. `orchestrate_multi_teacher`：`{ teachers, lessonSegments }` → 协同编排（无调度引擎时 degraded：单教师模式，全部片段归主讲）。
3. `match_teaching_scene`：`{ script }` → 场景匹配（无场景库时 degraded：固定背景）。
4. `generate_digital_human_video`：`{ script, avatarId }` → 制作清单（无视频引擎时 degraded：PPT+字幕清单，可交外部工具执行）。

**预期产物**：可执行的制作清单集。

**常见坑**：特化技能当前全部为降级实现（`level: degraded` 属设计预期，不是故障）；接入真实引擎（宿主注入对应 provider 钩子）后自动升级 full。

## 配方 5：科教融合备课——章节 + 会议摘要集 → 四件套

**目标**：给定一门课程的一个章节 + 一本会议摘要集，产出术语统一、可直接上课、可课后阅读复习、附教师教案的四件套（课件 Beamer PDF / 阅读材料 A4 PDF / 课后自测单文件离线 HTML / 教案 PDF）。把摘要集中真正与章节知识点对应的研究按课程位置放到该出现的地方。

**前提**：**纯本地零密钥**，无 LLM 也可跑通（选文退化为核心词直取、四件套退化为确定性骨架+诚实占位）；仓库自带开源示例可直接演练：`examples/摘要集-青年生态学论坛.txt`（虚构摘要集，含 \f 分页/分会场标题/编号条目，`entryPattern: "^\\d{4}\\s"`、`declaredTotal: 7`）+ `examples/章节知识点-生态系统生态学.json`（sections 入参）；有 LLM 时词族派生与正文质量显著提升。摘要集 PDF 需有文本层——纯扫描件先声明 OCR 降级（来源字段可核验性降为需人工逐项复核）。分页文本用 pdftotext 直出（`-layout` 与 `-raw` 双模式交叉，错位条目人工校序后照录）。

**调用序列**：

1. `gather_teaching_requirements`：`{ answers: { courseMeta, knowledgeStructure, abstractCollection, …Q1–Q8 }, corrections?: [...] }` → 清单逐项状态 + `stopWork` + 约束登记表。**stopWork=true 时不得进入下一步**——逐项问齐再动手，不预设不猜测；Q1–Q3（题名主讲/知识结构/摘要集）缺失是硬停工。
2. `parse_abstract_collection`：`{ pages: ["<pdftotext 分页>", …], entryPattern: "^\\d{4}\\s", declaredTotal: <封面自述篇数> }` → 结构化记录 + `pageOffset`（Δ 探测，不写死偏移）+ 缺陷旗标（`title_eats_author`/`cross_page_break` 等）+ 覆盖率。无分页时偏移报 `unavailable`，来源标注只给物理页。
3. `select_research_evidence`：`{ records: "$parse.records", sections: [{ title, knowledgePoints, keyPoints, confusables }], percentile: 0.2, perSectionMin: 1 }` → 入选 + `mustReview` 标记 + 落选理由 + 复核队列 + 收敛四条件。**mustReview 与全部课堂正文条目必须人工复核**（结论真的对应本节概念？带条件句？数字单位可核验？）；收敛未达时回扩词族/调阈值，不凑数。
4. `compose_teaching_artifacts`：`{ selected: "$select.selected", records: "$parse.records", courseStructure, venue, year, studentDrafts?, baseline? }` → `numberingMap`（案例=阅读编号、按节序）+ `sourceFields`（统一模板，"未提供"口径）+ 四件套内容源 + `violations`（H1 边界）。正文撰写在宿主侧按层完成：解读页五段式（K4）、易错点三处同表述（K5）、增量加工先备份并 diff 基线（A4）。
5. `audit_teaching_package`：`{ artifacts: { slides, reading: { pages }, html }, expectedNumbering: "$compose.numberingMap.caseNo" }` → C1–C8 判项 + `redlineTriggers`。**红线触发即停下向用户确认**，不自行决定；编译日志/写盘核验/打印态/定稿同步是 delegated 判项，由宿主按程序指引执行（验证阶梯便宜→昂贵：正则 → node --check → 两遍 xelatex → bbox≥5pt → headless → 目视抽查，前一步不过不进下一步）。
6. （闭环）验收 fail 项与红线触发经 `submit_feedback`（usage_issue/suggestion）入库，供 loop engineering 监控。

**预期产物**：四件套 PDF/HTML + 编号映射表 + 来源字段表 + 复核记录表（附录 F 落盘，供复盘"为什么选了这篇没选那篇"）。

**常见坑**：① 用户前提与事实不符（"这 6 篇就是全部吧"）——先枚举页脚去重给事实再问口径，不直接执行（红线 M1）；② 编号体系一变联动面 ≥6 处（页脚/案例卡/出处表/导航表/封面/收束）——一次性改全并做覆盖回归（C5）；③ 编译告警突增先归因（模板随页数线性增长属正常，M8）；④ 结论性数字找不到可靠命中就留白注明以教材为准（K2），**宁可少写一条数据，不可编一条关联**；⑤ 大材料链路分钟级耗时——六个技能支持 `async: true` 提交异步作业（`manage_async_tasks` 轮询，不受宿主单次调用超时限制）：配方 1/2 的 `parse_course_material`/`extract_knowledge_graph`/`fuse_knowledge_graphs`/`translate_multilingual`，以及本配方的 `parse_abstract_collection`（数百页摘要集）/`select_research_evidence`（LLM 词族派生 + 大候选池）；同步超时会附此建议。

## 配方 6：教学知识库——六环节统一取材（KAG-1）

**场景**：多材料课程（讲义/教材/摘要集/公开材料）要反复出教案、讲稿、题、答疑、课件——先建一次知识库，六个环节统一从库取材，不再各自翻原文。

**调用序列**：

1. `parse_course_material` × N → 各材料结构化输出；`extract_knowledge_graph` / `fuse_knowledge_graphs` → 课程图谱。
2. `build_teaching_knowledge_base`：`{ materials: [{ materialId, parse, origin?, citation? }], graph, qaPairs?, assessments? }` → KB（概念分层 + 段落级证据 + 关联 + 索引 + `coverageGaps` 缺口清单 + `acquisitionPlan` 采集清单）；默认落盘 `configDir()/kb/<kbId>/kb.json`。大语料 `async: true`。
3. `query_teaching_knowledge_base`：`{ kbId 或 kb, query, topK?, budgetTokens? }` → 证据包（倒排∪图谱扩展，得分构成与出处逐条可见；零命中出缺口+采集建议，绝不硬答）。
4. **六环节消费**（全部可选 `kbRefs` = 上一步 evidencePack，缺省行为不变）：教案 `design_course_structure`（lesson.evidenceRefs）→ 讲稿 `generate_teaching_script`（证据段并入取材池）→ 测试/出卷 `generate_assessment`（item.evidenceIds）→ 辅导 `realtime_qa_stream`（答案附证据出处）→ 课件 `export_course_package`（`knowledgeBase` → kb/kb.json 随包交付）。
5. **开放采集回路**（缺口驱动）：`coverageGaps`/`acquisitionPlan` → 按检索词三通道采集（SciVerse 学术证据 / 摘要集导入 origin=abstractCollection / 教师供给公开材料 origin=publicMaterial+citation）→ `build_teaching_knowledge_base` merge 模式（`base` + 新材料 + `externalConcepts`）→ 缺口闭合；LLM 提议挂接走 `llmLinkProposals`（mustReview）→ 人工确认 `confirmReview` 转 human。

**预期产物**：KB artifact（schema `nangying-starmap/kb@1`）+ 证据包 + 六环节带出处产物 + 采集清单/复核队列。

**常见坑**：① 换嵌入模型必须重建 KB（向量维度校验会拦截混用）；② inferred 概念与 llm 挂接未经 confirmReview 前，六环节输出里显式标注"待复核"，别当已确认事实用；③ citation 缺失字段就是"未提供"，绝不补造——导出与审计（audit_teaching_package C6 来源口径）依赖这一纪律；④ 库内无证据时按采集清单补料再查，不要让 LLM 凭世界知识硬答（红线）。
