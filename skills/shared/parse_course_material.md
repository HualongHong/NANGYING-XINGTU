# 课程材料解析（parse_course_material）

## 技能 ID
`parse_course_material`

## 中文名
课程材料解析

## 类型
共享型（shared）

## 输入
- `content`：课程材料的**纯文本内容**。文件路径或二进制内容的读取/解码归适配层，core 层协议无关、只接受已解码文本。
- `materialType`：材料类型标识，用于选择解析管线（如 md、txt、srt、vtt、pptx、pdf）。
- `ctx`（可选）：宿主注入上下文，可携带 `llm`（`LLMProvider`）启用**术语度过滤**（四类分类）。
- `options.llmFilter`（可选）：`'auto'`（默认，有 ctx.llm 即启用）| `'off'`（完全走启发式，行为与未注入一致）。
- `options.normalize`（可选）：文本规范化开关（默认 false）——全角空格/零宽字符清理、弯引号拉直、全角括号转半角、空白折叠（反馈 b P2-1：讲义二次清洗减负）。
- `options.language`（可选）：材料语种标识（默认 'zh'），透传标注于输出 `language` 字段；过滤规则后续按语种扩展。
- `options.glossary`（可选）：领域术语表 `string[]`——表内术语在文中出现即强制进入候选池（跳过停用过滤），保证领域词不被启发式丢弃（反馈 b P2-2 术语一致性前置）。

说明：`pptx`/`pdf` 属已知类型，但 core 层假定上游（适配层）已完成解码；真实二进制解析器（如 PDF 文本抽取）待适配层接入。

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "把课程材料文件解析为结构化章节、段落与知识点候选，是 parse→extract→design→script 链路的入口"
inputs:
  - name: materialFile
    kind: any
    required: true
    hint: "文件路径字符串（相对路径按 workspaceRoot > 进程 cwd 解析），或已解码对象 { content, materialType }"
  - name: materialType
    kind: string
    required: false
    hint: "材料类型标识（md/txt/srt/vtt/pptx/pdf/docx…），按扩展名自动推断，一般无需传"
  - name: workspaceRoot
    kind: string
    required: false
    hint: "工作区根目录：materialFile 为相对路径时优先相对它解析（MCP 子进程 cwd 与宿主工作区不一致时必传）"
  - name: async
    kind: boolean
    required: false
    hint: "true 时提交异步作业、毫秒级返回 jobId，用 manage_async_tasks 轮询（不受宿主超时限制）"
  - name: ocr
    kind: boolean
    required: false
    hint: "扫描件 OCR：true 强制走 OCR；false 禁用；缺省自动探测（≥3 页图像且无实质文本层的 PDF 才自动 OCR，标注 ocrAuto:true）。文本层 PDF 一律原生抽取优先（textLayer:true）。护栏：≤20MB、≤60 页、逐页并发 2、单页超时 90s"
  - name: progress
    kind: boolean
    required: false
    hint: "true 请求进度回报：异步作业进度写快照；MCP 通道经 progress 通知推送"
  - name: options
    kind: object
    required: false
    hint: "{ llmFilter?: 'auto'|'off', extraStoplist?: string[], normalize?: boolean, language?: string, glossary?: string[] }；normalize=中文标点/全角空格清洗（默认 false），glossary=术语表强制入池"
```
## 输出
- `structuredSections`：结构化章节列表（标题、层级、顺序）。章节识别覆盖 Markdown 标题与中文编号模式（"第一章""一、"）及数字编号（"1.""1.1"）。
- `paragraphs`：段落级文本切片（空行分段，连续列表项并入同一段落），含所属章节序号（无章节时为 -1）。
- `tables`：**结构化表格**（反馈 b P1-1，表格保真）。Markdown 管道表格与 docx 表格行（` | ` 形态）抽取为 `{ header, rows, sectionOrder }`——表头为键、每行为记录；表格行**不再**被折行合并压成一个 paragraph；单元格文本（4–30 字）去重并入知识点候选（score=1 低权追加）。无表格时为空数组。
- `knowledgePointCandidates`：知识点候选清单（**score = 不同出现位置数**；命中段落序号数组作为来源位置）。
  抽取为两阶段架构：**阶段一**滑窗统计全部 n-gram（2–12 字）的 distinct 位置，bump 时经四道过滤——① 课件模板停用表（双向匹配 + ≥3 字子串包含）；② 通用词表 GENERIC_STOPWORDS（约 300 个高频动词/形容词/通用名词全词匹配，频率≠术语度）；③ 功能字/操作动词规则（含 {了,把,被,将,是,在}、以 {用,将,把,被,使,当,按,若,从} 起首、以方位/进行结尾、叠字 AA 型、超长含"的"整句模板）；④ URL/邮箱（含裸 https/www）。
  **阶段二 MRS（极大重复子串）**：保留 g 当且仅当左右各扩 1 字（扩展字排除语法附着字）都形不成 distinct ≥2 的更重复串——任何错开窗口碎片必可扩展，算法上一次清零（替代打地鼠式个案正则）。副作用（设计预期）：短术语被更长的高频组合吸收（"电泳"→"电泳技术"）；**高频头词救援**：distinct ≥10 的术语即使被吸收也保留（头词搭配多样时的核心概念，如"生态因子"）。
  `options.extraStoplist` 可追加自定义停用词。**输出保留完整候选池（不再截断）**——截断上限由下游 extract_knowledge_graph 建图时按需应用；fuse_knowledge_graphs 跨文档融合路径使用全量池（修复共享基础概念被 top-N 挤出的词表稀释问题）。经 LLM 精炼归并后的候选不保留来源位置（score=0、occurrences 为空）。

## 依赖
- `documentParser`：文档解析引擎（必需；实际解码工作由适配层承担，core 层消费其产出的纯文本）
- OCR 能力（可选，用于扫描版 PDF 与图片型 PPT；见下节"扫描件 OCR 摄取"）
- `llm`（可选）：宿主注入的大语言模型，用于知识点候选的精炼/归并
- `decoder`（可选）：宿主注入的文档解码器（`DocumentDecoder`，见 core/decode/documentDecoder.ts）

## 原生 PDF 文本层抽取（R6）
- PDF 一律先经**原生文本层抽取**（零依赖：对象扫描 + ObjStm 展开 + FlateDecode 流 + ToUnicode CMap 的 CID→Unicode + Tj/TJ 算子）；抽到实质文本（>100 字符）直接走文本路径，**完全跳过 OCR**，`degradationNote` 标注 `textLayer:true`。
- 覆盖 PPT/Word 导出的幻灯片 PDF（有真实文本层、每页带背景灰图——此前被"≥3 页图像"误判走 OCR 产乱码）。
- 无 ToUnicode 的西文按 cp1252 直用；CID 无映射字形跳过并标 partial；文本层缺失/不足才落入 OCR 通道。

## 扫描件 OCR 摄取（R5-1）
- **触发**：`ocr:true` 强制；`ocr:false` 禁用；缺省自动探测——PDF 含 ≥3 页图像（页数多、文本少的扫描件特征）自动走 OCR，degradationNote 标注 `ocrAuto:true`。
- **资源护栏**：单文件 ≤20MB（超限结构化报错）；扫描件 ≤60 页（超限报错并建议拆分）；逐页并发 2；单页超时 90s（超时不拖垮整册，该页记失败）；任何解码错误被捕获并回落既有解码链——**绝不使进程退出**（7.46MB 扫描件打死 MCP 服务的根因治理）。
- **输出**：段落/表格带 `page`（OCR 来源页）与 `source:"ocr"`；`meta.ocr = { engine, language, pages, elapsedMs, auto }`。
- **长任务**：同步解析 >5s 时输出建议 `async:true` 提交异步作业（manage_async_tasks 轮询，不受宿主超时限制）。

## 文档解码（双重供给）
二进制文档（PDF/PPTX 等，`looksBinary` 守卫：采样前 8KB，\x00 占比 >1%）按序走双重供给：
1. **宿主注入**：`ctx.decoder`（`SkillContext.decoder`，与 `llm` 并列的注入点）；
2. **用户配置**：内置供应商解码器（`adapters/core/decoders/`：kimi 文件解析、openai 视觉转录），配置经 `pnpm config` 向导写入本机，密钥分离存放。

两者皆不可用时，退化为可读文本尽力提取（`level: degraded`），中文说明提示需注入解码器或运行配置向导。

PPTX 走**原生文本优先**：内置抽取器直接解 zip 包取 `ppt/slides/slideN.xml` 的 `<a:t>` 文本（按幻灯片数字序分页，含演讲者备注），不做 OCR 渲染；纯图片课件（无文本层）返回降级说明（图片渲染 OCR 本期不做）。

### 教材模式（OCR 文本增强）
针对教材 OCR 文本的专项守卫（core 启发式内建）：
- **标题守卫**：纯数字/小数行（"16.8"）永不成为标题；"N. 标题"样式 A 限全行 ≤25 字、标题部分不以标点收尾、不含疑问号；连续 ≥2 行整数编号短行视为习题/编号列表块，按正文处理（挂到当前章节）。
- **页眉页脚过滤**："短标题 + 页码"行（`^.{2,24}\s+\d{1,3}$`）在文档中出现 ≥3 次（去页码归一）→ 从段落流剔除。
- **OCR 碎片改善**：中文 n-gram 上限 8 字（完整长术语可成候选）；两阶段去重（先 ≥4 字术语）；**前缀碎片丢弃**——已收术语 t 是更长已收术语 T（|T|≥|t|+2）的前缀且 T 词频 ≥30%·t 则清除 t（"生物的生"被"生物的生长发育"清除）。后缀位置碎片与真术语仅凭词频无法可靠区分，由下游 extract 的"出现段落子集"归并处理。
- 已知 OCR 质量项："第N章"被 OCR 粘连数字（如"2 0绪论"）不做硬修，建议上游 OCR 质量治理。
- **折行合并**：无空行的连续普通行视为换行折行并为一个段落（CJK 无缝、英文边界补空格），列表项与正文互切处分段——消除 PDF 换行造成的碎片候选。
- **重复页眉守卫**：同一标题文本出现 ≥3 次且在标题次序中相邻（课件页眉式重复，如每页"2. 实验原理"）→ 整体降级为正文；章节型重复小节（次序间有其他标题）不误伤。
- **弹性候选上限（下游应用）**：extract_knowledge_graph 建图时默认按 20 + 字数/4000（封顶 60）取 top-N；parse 自身输出完整候选池。

## LLM 术语度过滤（实验课程领域约束）

注入 LLM 时，候选经**四类分类**过滤（分批 ≤100）：
- `term`（学科术语/概念/物质/方法名）——保留
- `operation`（**实验操作技能**：离心、滴定、点样、层析、恒温水浴——实验课程中操作技能也是知识点）——保留
- `phrase`（叙述短语/过程描述/课件套话，如"用纱布过滤""剧烈震荡后取出"）——丢弃
- `noise`（OCR 错字/碎片/无意义串）——丢弃

分类理由随结果返回；某批非法 JSON → 该批保留原候选并整体标 degraded；未注入 LLM 或 `llmFilter: 'off'` → 完全走启发式（行为一致，单测锁定）。**启用阈值（契约锁定，反馈 c P1-1）**：有 LLM 且候选数 ≥10 明确保证启用；1–9 个候选同样尝试（单批轻量），小材料不再整份跳过过滤。过滤报告随输出附 `llmFilterReport`：`{ enabled, degraded, kept, dropped, distribution, droppedSamples }`。

## 降级策略
- 格式不被解析引擎支持时，退化为纯文本提取：直接抽取可读文本，章节层级退化为按标题启发式切分（等级标记 degraded）。
- 宿主注入的 LLM 精炼失败（返回非法内容或解析异常）时，自动回落启发式候选并标记 degraded。

## 调用示例
```json
{
  "skillId": "parse_course_material",
  "inputs": {
    "content": "# 机器学习概述\n\n机器学习是人工智能的重要分支……",
    "materialType": "md"
  },
  "ctx": {
    "llm": "<宿主注入的 LLMProvider，可选>"
  }
}
```
