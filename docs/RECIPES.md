# 配方（Recipes）：教学助理引导下的典型工作流

面向"DSH 里被教学助理 preset 引导"的场景：用户说一句目标，preset 按下列顺序指挥 `mcp__nangying_starmap__*` 工具完成。每个配方标注前提（LLM 配置状态的影响）、调用序列（编号 + skillId + 关键入参）、预期产物与常见坑。

> LLM 状态说明：宿主注入（正式路径）或 `pnpm config`（终端用户）或 `.env`（调试）任一可用即"有 LLM"。无 LLM 时全链路仍可跑通（启发式降级），但候选过滤、译文润色、理由生成等增强缺失。

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
