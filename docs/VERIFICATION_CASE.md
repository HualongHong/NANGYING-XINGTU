# 囊萤星图 v1.5.0 · DSH Desktop 全功能验证案例

> 目的：在 DSH Desktop 对话环境中逐项验证 27 个技能的真实表现。
> 前置：重启 DSH Desktop（MCP 注册指向 `dist/server/mcp.js`，每次升级后必须重启）。
> 材料：本仓库 `testfiles/` 目录（用户机器上路径为 `D:\opt\dev\NangYingXingTu\testfiles`）。
> 标注约定：✅ = 应有明确成功标志；⚠️ = 允许 degraded（降级诚实即算通过）；❌ = 应得到结构化报错（报错正确即算通过）。
> LLM 说明：标有〔LLM〕的步骤受宿主 LLM 注入影响，数值会有波动，但 level 与结构应当稳定。

---

## 第 0 组 · 环境与自检

### 0.1 能力清单
**粘贴：** `调用 nangying_starmap 的 describe_capabilities，列出全部技能及其引擎状态`

✅ 预期：返回 27 个技能；OCR 显示 `builtin`（tesseract + 语言包就绪）；ffmpeg 若已装显示 `optional-not-installed`→`builtin`，未装则带安装指引；7 个特化技能（数字人/TTS/实时等）显示 `not-provided` 与降级形态。

### 0.2 文件与扩展名不符检测
**粘贴：** `用 render_preview 检查 D:\opt\dev\NangYingXingTu\testfiles\生物化学实验\生化实验讲义.pdf`

✅ 预期：`fileType: "pdf"`，页数 ≥100，每页字符量报告，文本层判定 true，OCR 建议为"不需要"。
**进阶（可选）：** 手动把任意 docx 复制一份改名 `.pdf` 再测 → 应出现 `contentMismatch: true` + degraded 显著说明。

---

## 第 1 组 · 主链路（讲义 → 图谱 → 结构 → 讲稿）

### 1.1 解析文本讲义
**粘贴：** `调用 parse_course_material 解析 D:\opt\dev\NangYingXingTu\testfiles\基础生态学\_ch01.txt`

✅ 预期：level=full；sections ≥3；knowledgePointCandidates ≥50；无报错。

### 1.2 概念图谱 + 溯源
**粘贴：** `对上一步的解析结果调用 extract_knowledge_graph，输出 json 格式`〔LLM 若注入则候选经 LLM 过滤，report.enabled=true；未注入则 degraded 但仍有图谱〕

✅ 预期：`schemaVersion:"1.2"`；实体带 `source`（sectionOrder/paragraphIndexes）与 `confidence`；边带 `provenance`；hierarchy 与 prerequisiteGraph 非空。

### 1.3 图谱可视化导出
**粘贴：** `把上一步的图谱用 mermaid 格式重新输出`

✅ 预期：`data.output` 为 flowchart 文本（先修实线/related 虚线）；同样可试 `graphml` / `csv` / `jsonld`。

### 1.4 课程结构
**粘贴：** `基于该图谱调用 design_course_structure，objectives 为 {audience:"本科二年级", totalMinutes:45, courseType:"lecture", deliverables:["讲稿","习题课"]}`

✅ 预期：lessonSegments 总时长 ≈45 分钟；courseType 回声 lecture；deliverables 回声。

### 1.5 分镜讲稿（含必含清单）
**粘贴：** `用 generate_teaching_script 生成讲稿，传入上一步结构，requiredConcepts 给 3 个图谱中的概念 id`

✅ 预期：storyboard/voiceover/subtitle 三稿；coverage 报告中 3 个必含概念标注 covered（若未覆盖会诚实标注 missed）。

---

## 第 2 组 · 实验型图谱（生化实验场景）

### 2.1 解析实验课件 PDF
**粘贴：** `调用 parse_course_material 解析 D:\opt\dev\NangYingXingTu\testfiles\生物化学实验\9. 米氏常数的测定-2022.pdf`

✅ 预期：level=full；`meta.ocr.textLayer=true`（检测到文本层，跳过 OCR）；段落为真实中文（如"米氏常数的测定"），**不是乱码**。

### 2.2 实验图谱
**粘贴：** `用 extract_knowledge_graph 的 graphType=experimental 模式，sections 传 [{id:"EXP9", title:"米氏常数的测定", fields:{"标准":["底物浓度系列"],"样品":["酶液"],"指标":["Km","Vmax"],"仪器":["分光光度计"],"操作链":["配制底物梯度","加酶启动反应","定时测吸光度","作双倒数图"],"质控":["空白对照","平行样"],"产出":["Km测定值"],"难点":["初速度窗口选择"]}}]`

✅ 预期：实体类型覆盖 experiment/indicator/instrument/step/qc/output/difficulty；step 实体带 order；stats.byType 按类统计；step_order 关系保序。

### 2.3 图谱融合与比对
**粘贴：** `把 2.2 的实验图谱与 1.2 的概念图谱做 fuse_knowledge_graphs`（再单独 diff 一次）

✅ 预期：fuse 返回合并图 + 来源标注；diff 返回增/删/改清单。

### 2.4 一致性核查
**粘贴：** `调用 audit_consistency，assets 传 [{name:"教学大纲",text:"…总学时48…"},{name:"进度表",text:"…总学时64…"}]`

✅ 预期：冲突清单中检出"学时 48 vs 64"，带涉及资产与修改建议。

---

## 第 3 组 · 教学智能（问答/路径/反馈/命题）

### 3.1 问答库
**粘贴：** `基于 1.2 的图谱调用 build_qa_knowledge_base`

✅ 预期：qaPairs 非空，带意图标签与检索索引。

### 3.2 学习路径
**粘贴：** `用 recommend_learning_path，graph 传 1.2 图谱，profile 传 {targetConcept:"群落演替", availableHours:4, masteredConcepts:[前两个概念id]}`

✅ 预期：路径以已掌握概念为起点、目标概念为终点，满足先修拓扑序。

### 3.3 自由文本作业批改〔LLM〕
**粘贴：** `调用 generate_personalized_feedback，freeTextReport 传一段学生实验报告文字（可现编，如"我做了酶活实验但是没设空白对照，数据看起来还行…"）`

✅/⚠️ 预期：有 LLM 时段落级反馈指出"缺空白对照"；无 LLM 时 degraded 模板反馈。quiz 形态入参仍兼容。

### 3.4 自动命题
**粘贴：** `用 generate_assessment 基于 1.2 图谱出 5 道题，难度 mixed，含解析与典型错误`

✅ 预期：5 题带题型/Bloom/答案/解析/评分点；每题有图谱出处。

---

## 第 4 组 · 多语与润色

### 4.1 双语同步 mirror〔LLM〕
**粘贴：** `调用 sync_bilingual，mode=mirror，primaryText 传 1.5 的 voiceover 前 3 段，secondaryLang=en，glossary 传 {"群落演替":"community succession"}`

✅/⚠️ 预期：中文与原文逐字一致；英文逐段对齐；术语按 glossary 锁定。

### 4.2 常规翻译
**粘贴：** `用 translate_multilingual 把同一段讲稿译成 en 和 ru`

⚠️ 预期：无翻译引擎时正确降级（这不是缺陷，是设计）；有宿主 LLM 时产出译文。

### 4.3 去机器味〔LLM〕
**粘贴：** `调用 polish_teaching_text，text 传一段含"接下来我们看…"的讲稿文字，preserveTerms 传 ["米氏常数","Km"]`

✅ 预期：套话清除或进 changes 报告；stats 有 clicheRemoved；术语"米氏常数"在 polished 中原样保留。

---

## 第 5 组 · 课程包导出（含 PDF 直出）

**逐条粘贴：**
1. `用 export_course_package 导出上一步讲稿为 scorm`
2. `…导出为 ims`
3. `…导出为 handout-docx`
4. `…导出为 slides-pptx`
5. `…导出为 handout-pdf`
6. `…导出为 xlsx（tables 传两表：{header:["概念","所属章节"],rows:[["群落演替","第三章"]]} 之类）`
7. `…导出为 starmap-svg 和 starmap-html（graph 传 1.2 或 10 组的图谱）`

✅ 预期：全部 level=full（1-4、6-7 无外部依赖；5 在本机有中文字体时应 full——内嵌子集化字体，体积应远小于 15MB，数百 KB 级）。产物结构有效（docx/pptx/xlsx 是真实 zip，PDF 以 %PDF 开头，svg 以 `<svg` 开头）。xlsx 可用 render_preview 读回核对行列数；starmap-svg 含图例与节点（产业图谱渲染出六类本体分区）。
**进阶：** 加 `outputPath` 参数 → 产物落盘，输出报告绝对路径；`directoryTemplate` 自定义课时目录。

---

## 第 6 组 · 媒体验收（qa_media）

### 6.1 字幕静态检查
**粘贴：** `调用 qa_media，subtitles 传一个有两条时间轴重叠的 SRT 文本`

✅ 预期：检出重叠区间（无 ffmpeg 也可跑，此检查永远可用）。

### 6.2 视频探测（需本机装 ffmpeg）
**粘贴：** `用 qa_media 检查任意一个视频文件（mediaFile 传路径）`

✅/⚠️ 预期：有 ffmpeg → 元数据+关键帧密度+静音报告；**渐变画面素材会自动降档复扫（0.3→0.15→0.05）并在报告注明；检不出时诚实报告"无显著场景切换"，不伪造**；无 ffmpeg → unavailable + 安装指引。

---

## 第 7 组 · 资产管理

**粘贴（依次）：**
1. `调用 manage_course_assets，operation=register，登记刚才生成的讲稿与课程包，storePath 传 D:\opt\dev\NangYingXingTu\testfiles\_eval\registry.json`
2. `operation=list，storePath 同上`
3. `operation=export，storePath 同上`

✅ 预期：register→full 且落盘；**再次 list 资产仍在**（R1 修复点：跨调用持久）；export 产出登记簿文件。

---

## 第 8 组 · 异步与护栏

### 8.1 大文件异步
**粘贴：** `调用 parse_course_material 解析 D:\opt\dev\NangYingXingTu\testfiles\生物化学实验\生化实验讲义.pdf，加 async:true`

✅ 预期：毫秒级返回 jobId → `manage_async_tasks 查询该 jobId 的进度` → 完成后 data 非空（108 页，LLM 注入时全程可能数分钟）。

### 8.2 任务清理
**粘贴：** `调用 manage_async_tasks，operation=cleanup`

✅ 预期：清理过期 terminal 任务，返回清理数；interrupted 任务 elapsedMs 不再有异常大值。

### 8.3 体积护栏
**粘贴：** `调用 parse_course_material 解析 D:\opt\dev\NangYingXingTu\testfiles\基础生态学\基础生态学第3版.pdf`

❌ 预期：**快速**返回结构化报错（20MB 上限、当前 213MB），给出 async/分段/外部转文本三条建议；服务不崩，后续调用照常。

---

## 第 9 组 · 特化技能降级诚实性

**粘贴：** `依次调用 register_teacher_avatar、generate_digital_human_video、synthesize_speech、orchestrate_multi_teacher、match_teaching_scene、sync_multilingual_av、realtime_qa_stream（入参按各工具 schema 给齐）`

⚠️ 预期：全部返回 `level=unavailable`（或 degraded）+ 明确说明缺哪个引擎、降级形态是什么（静态头像/纯字幕/固定背景等）——**不假装成功即通过**。

---

## 第 10 组 · 产教图谱与就业对齐

**粘贴：** `build_industry_graph（text 传 3-4 个岗位 JD 合并文本，如"体外诊断试剂研发工程师：要求熟悉酶动力学参数测定、分光光度法、GLP 规范。负责试剂配方开发与验证……"）→ 对《米氏常数的测定》parse+extract 的 courseGraph 调 link_knowledge_industry（可附 jobPostings 原文）→ recommend_learning_path 加 targetOccupation 重跑`

✅ 预期：
- `build_industry_graph`：无 LLM 时 level=degraded 并注明"词面启发式"；实体含 occupation/skill/workTask（nodeType 标注），stats.byType 计数正确；同输入两次调用输出一致
- `link_knowledge_industry`：matched 词面层 ≥1（如课程「测定」→「酶动力学参数测定」包含匹配 0.8）；gaps 按 heat（关联岗位数加权）降序，每项带"建议补充教学点：X"建议；coverage 列出零产业关联课程实体
- **共现窗口验证（R10）**：无 LLM 降级态下，岗位 A 不应连到只在岗位 B JD 文本中出现的技能（句子级共现，可传 `lexicalWindow` 调窗口）；若仍出现跨岗位全连接即为回归
- `recommend_learning_path` + targetOccupation：degradationNote 含"目标岗位「…」：N 项要求技能，课程词面覆盖 M 项，缺口 K 项（…）"；缺口技能的先修概念在路径前部
- 三张图谱（conceptual/experimental/industry）两两 fuse 不报错；fused 图谱可再喂给第 5 组的 starmap 格式渲染

---

## 验收汇总

| 组 | 覆盖 | 通过标准 |
|---|---|---|
| 0 | describe_capabilities / render_preview | 29 技能、引擎三分、类型识别 |
| 1 | parse / extract / design / script | 主链路 level=full、溯源字段 |
| 2 | experimental / fuse / diff / audit | 实验图谱八类实体、融合比对、冲突检出 |
| 3 | qa库 / 路径 / 反馈 / 命题 | 全链路产出非空且结构完整 |
| 4 | sync_bilingual / translate / polish | 中文零改动、术语锁定、套话清除 |
| 5 | export 七种格式 | 全 full、PDF 子集化字体、xlsx/starmap 可读回、可落盘 |
| 6 | qa_media | 字幕检查永远可用、ffmpeg 门控诚实 |
| 7 | manage_course_assets | 跨调用持久化 |
| 8 | async / cleanup / 护栏 | jobId 闭环、脏值清理、护栏快速报错 |
| 9 | 7 特化技能 | 降级诚实 |
| 10 | 产教图谱 | 产业六类本体、缺口报告按岗位热度排序、路径缺口倒排 |

**任何一步与预期不符，请把该步的提示词与返回原文记入 `docs/dev/feedback/` 新文件**（该目录为项目内部反馈区，不入库），下次迭代按此修复。
