# 技能速查表

共 33 个技能：共享型 26 个（平台无关）+ 特化型 7 个（可降级）。

## 共享型技能

| ID | 中文名 | 输入 → 输出 | 降级策略 |
|---|---|---|---|
| parse_course_material | 课程材料解析 | PPT/PDF/字幕 → 章节、段落、知识点候选 | 不支持的格式退化为纯文本提取 |
| extract_knowledge_graph | 知识图谱提取 | 结构化内容 → 实体、关系、层级、先修图 | 仅抽取标题层级 |
| design_course_structure | 智慧课程结构设计 | 图谱+教学目标 → 脚本、结构、流程 | 模板化结构 |
| generate_teaching_script | 教学脚本生成 | 课程结构 → 分镜稿、口播稿、字幕稿 | 纯文本讲稿无分镜 |
| translate_multilingual | 多语种翻译 | 中文讲稿 → 中英俄法韩多语文本+术语表 | 仅中英双语 |
| build_qa_knowledge_base | 问答库构建 | 图谱+讲稿 → 问答对、检索索引、意图标签 | 关键词倒排索引 |
| recommend_learning_path | 学习路径推荐 | 图谱+学习者画像 → 个性化路径 | 按先修拓扑默认顺序 |
| generate_personalized_feedback | 个性化反馈 | 学习行为+测验 → 反馈与建议 | 通用模板反馈 |
| export_course_package | 课程包导出 | 课程资产 → SCORM/IMS/字幕/多语包/docx/pptx/pdf/xlsx | 仅 Markdown+字幕 zip |
| manage_course_assets | 课程资产管理 | 操作指令 → 资产登记、版本、元数据 | 本地文件系统登记 |
| fuse_knowledge_graphs | 知识图谱融合 | 多图谱+来源权重 → 融合图、归并报告 | LLM 对齐失败时 conflicts 如实返回 |
| diff_knowledge_graphs | 知识图谱比对 | 两图谱 → 实体/边差集与相似度 | 纯结构 diff，无 LLM 依赖 |
| manage_async_tasks | 异步任务管理 | query/list/cancel/cleanup → 作业状态、进度、结果 | 内存注册表直查 |
| describe_capabilities | 能力自述 | 可选 skillId → 真实入参契约（真名/别名/必填/上游/降级） | 按注册表静态输出 |
| generate_assessment | 图谱命题 | 图谱 → 题干/题型/难度/Bloom/答案/解析 | 模板题兜底 |
| audit_consistency | 一致性核查 | ≥2 材料 → 日期/学时/口径/覆盖矛盾清单 | 纯文本交叉比对 |
| polish_teaching_text | 文本润色 | 教学文本 → 去机器味改写（术语保护） | 无 LLM 返回规则级建议 |
| sync_bilingual | 双语同步 | 中文锚+译文 → 逐段对齐/术语锁定/一致性 | 规则对齐兜底 |
| qa_media | 媒体验收 | 视频/字幕 → 场景切换/静音/时间轴门禁报告 | 无 ffmpeg 时仅字幕静态检查 |
| render_preview | 版面预览 | docx/pptx/pdf/xlsx → 大纲/要点/扫描件判定 | 魔数识别+文本层降级 |
| build_industry_graph | 产业图谱 | 产业材料 → 六类本体五类关系产业图谱 | 启发式抽取 |
| link_knowledge_industry | 产教关联 | 课程图+产业图 → 供需缺口/覆盖冗余报告 | 词面匹配兜底 |
| submit_feedback | 反馈协调 | 问题/满意执行（含未用插件）→ 脱敏草稿 → 审阅门后入库 | 输入非法不储存；approve 未通过拒绝 |
| settings_card | 设置卡片 | render 卡片 → 用户填写 → apply 入库（密钥永不回显） | 输入非法拒写入；未识别平台走保守政策 |
| enrich_knowledge_evidence | 学术证据增强 | 图谱/查询 → SciVerse 逐实体检索 → academicEvidence 合并回图谱 | 平台不可用 degraded 原样回传，证据后补 |
| inspect_teaching_dataset | 教学数据集探查 | repo → 元信息+文件清单+教学相关性评分 | 公共仓库匿名可用；受限仓库提示配 AK/SK；失败不影响主流程 |

## 特化型技能

| ID | 中文名 | 输入 → 输出 | 降级策略 |
|---|---|---|---|
| register_teacher_avatar | 教师数字分身注册 | 教师档案+素材 → 分身ID、声音档案 | 静态头像+文字讲稿 |
| generate_digital_human_video | 数字人授课视频生成 | 讲稿+分身+场景 → 授课视频、字幕轨 | PPT+字幕视频 |
| synthesize_speech | 多语种语音合成 | 多语文本+声音档案 → 音轨 | 纯字幕输出 |
| orchestrate_multi_teacher | 多教师数字分身协同 | 结构+多分身+计划 → 分段、镜头表 | 单教师模式 |
| match_teaching_scene | 多场景智能匹配切换 | 片段+场景库 → 场景匹配、转场 | 固定背景 |
| sync_multilingual_av | 多语种音视频同步 | 画面+音轨+字幕 → 对齐多语包 | 分语种独立输出 |
| realtime_qa_stream | 实时问答流式交互 | 问答库+提问 → 流式答案 | 异步问答 |

## 主流程调用图

```
                 parse_course_material
                          │
                 extract_knowledge_graph
                          │
                 design_course_structure
                          │
                 generate_teaching_script
                    ┌─────┴─────┐
                    ▼           ▼
          translate_multilingual   build_qa_knowledge_base
                    │                    │
          synthesize_speech ◀────────────┤
                    │                    │
          generate_digital_human_video   │
                    │                    │
          sync_multilingual_av           │
                    │                    │
   recommend_learning_path / generate_personalized_feedback
                    │                    │
                    └────────┬───────────┘
                             ▼
                   export_course_package
                             ▲
                   manage_course_assets（支撑全局资产）

   特化增强环（可选，按能力档案启用/降级）：
     register_teacher_avatar → 供 generate_digital_human_video / synthesize_speech
     orchestrate_multi_teacher、match_teaching_scene → 增强视频生成
     realtime_qa_stream ← 消费 build_qa_knowledge_base
```

各技能详细契约见 `skills/shared/` 与 `skills/specialized/` 下的 md 文件。
