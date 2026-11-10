# 技能速查表

共 29 个技能：共享型 22 个（平台无关）+ 特化型 7 个（可降级）。

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
