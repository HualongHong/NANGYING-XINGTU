# 课程包导出（export_course_package）

## 技能 ID
`export_course_package`

## 中文名
课程包导出

## 类型
共享型（shared）

## 输入
- `script`：教学脚本（generate_teaching_script 的 TeachingScript，必选）
- `translations`：多语版本（可选）`[{ lang, script }]`（translate_multilingual 产物的同构结构）
- `graph`：课程知识图谱（可选，导出为 graph.json）
- `qaKnowledgeBase`：问答库（可选，导出为 qa.json）
- `meta`：包元数据（可选）`{ title?, author?, lang? }`
- `options`：导出选项（可选）`{ formats?, packageName?, lang? }`；formats ∈ `scorm` | `ims` | `markdown` | `subtitles` | `multilingual` | `starmap-svg` | `starmap-html`，缺省为全部
- `outZip` / `outDir`（可选）：写出真实产物（适配层，给了才落盘；core 只产出内容模型）
- `outXlsx`（可选）：formats 含 `xlsx` 时写出真实 .xlsx 多表文件；内容取 `linkReport`（产教分析包三表）或通用 `tables`（`[{ name?, header, rows }]`）；无 `outXlsx` 但有 `outputPath` 时写 `outputPath/tables.xlsx`

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "把教学脚本等课程资产导出为 SCORM/IMS/字幕/多语/星图等标准交付包"
inputs:
  - name: script
    kind: object
    required: true
    aliases: ["courseAssets"]
    hint: "generate_teaching_script 的输出（TeachingScript）"
    producer: ["generate_teaching_script"]
  - name: translations
    kind: array
    required: false
    hint: "多语版本 [{ lang, script }]（translate_multilingual 产物同构）"
    producer: ["translate_multilingual"]
  - name: graph
    kind: object
    required: false
    hint: "课程知识图谱（导出 graph.json 与星图可视化）"
    producer: ["extract_knowledge_graph", "fuse_knowledge_graphs"]
  - name: qaKnowledgeBase
    kind: object
    required: false
    hint: "问答库（导出 qa.json）"
    producer: ["build_qa_knowledge_base"]
  - name: meta
    kind: object
    required: false
    hint: "包元数据 { title?, author?, lang? }"
  - name: options
    kind: object
    required: false
    hint: "{ formats?: string[], packageName?: string, lang?: string, directoryTemplate?: string }；formats ∈ scorm|ims|markdown|subtitles|multilingual|starmap-svg|starmap-html|handout-docx|slides-pptx|handout-pdf|xlsx（handout-docx/slides-pptx/handout-pdf/xlsx 为可选写出，不进默认全集；handout-pdf/xlsx 由适配层真实写出，配 outPdf/outXlsx/fontPath）；directoryTemplate 自定义课时目录（令牌 {lesson} {lessonId} {index} {ext}，替换默认 markdown/package.md）"
  - name: outZip
    kind: string
    required: false
    hint: "给出则把课程包写出为 zip 文件（适配层落盘）"
  - name: outDir
    kind: string
    required: false
    hint: "给出则把课程包写出为目录（适配层落盘）"
  - name: outDocx
    kind: string
    required: false
    hint: "给出且 formats 含 'handout-docx' 时，把 OOXML 部件组装为真实 .docx 写出（讲稿/教案：标题+分镜表格）"
  - name: outPptx
    kind: string
    required: false
    hint: "给出且 formats 含 'slides-pptx' 时，把 OOXML 部件组装为真实 .pptx 写出（分镜逐页：标题+要点）"
  - name: outputPath
    kind: string
    required: false
    hint: "产物直接落盘工作区目录：整包文件 + docx/pptx 组装件；绝对路径列表写入 data.writtenFiles"
  - name: outPdf
    kind: string
    required: false
    hint: "formats 含 'handout-pdf' 时写出真实 .pdf（试卷/讲义直出）：有 fontPath/系统字体则嵌入中文，否则诚实降级为拉丁 PDF 并标 degraded；blocks 表格格支持 { text, colSpan?, rowSpan?, align? } 合并单元格（R13），无 span 纯字符串格子行为不变"
  - name: fontPath
    kind: string
    required: false
    hint: "中文字体路径（.ttf/.otf/.ttc，如 C:/Windows/Fonts/msyh.ttc）；缺省探测常见系统字体，均无则降级说明"
  - name: outXlsx
    kind: string
    required: false
    hint: "formats 含 'xlsx' 时写出真实 .xlsx（零依赖 OOXML zip，多 sheet 内联字符串）：内容取 linkReport（缺省 tables）；无 outXlsx 但有 outputPath 时写 outputPath/tables.xlsx"
  - name: tables
    kind: array
    required: false
    hint: "通用表格 [{ name?, header: string[], rows: string[][] }]，formats 含 'xlsx' 且未给 linkReport 时作为各 sheet 内容"
  - name: linkReport
    kind: object
    required: false
    hint: "link_knowledge_industry 输出（{ matched, gaps, coverage }），formats 含 'xlsx' 时导出为产教分析包三表（matched 关联/gaps 缺口/coverage 冗余）"
    producer: ["link_knowledge_industry"]
  - name: handoutTables
    kind: array
    required: false
    hint: "handout-docx 附加表格 [{ title?, rows }]，rows 为行数组、格子支持纯字符串或 { text, colSpan?, rowSpan?, align? }（R14：gridSpan/vMerge 合并单元格，对齐 handout-pdf 的 PdfCell 设计）；追加在分镜表之后，不影响既有 storyboard 表格"
```
## 输出
- `package`：包内容模型 `{ manifest, files: [{ path, content }] }`——确定性文件条目列表（POSIX 相对路径，按路径排序），压缩/落盘归适配层（`adapters/core/packageWriter.ts`：零依赖 ZIP 或目录输出）
- `scormPackage`：SCORM 1.2 最小结构包路径（`scorm/imsmanifest.xml` + 内容页 HTML；不追求官方认证）
- `imsPackage`：IMS Common Cartridge 最小结构包路径（`ims/imsmanifest.xml`）
- `subtitleFiles`：字幕文件路径列表（SRT，含多语种）
- `multilingualPackage`：多语包目录路径（`multilingual/`）
- `starmap`：`starmap/starmap.svg` + `starmap/index.html`——知识图谱星图可视化（R12-1 起实际产出：formats 含 starmap-svg/starmap-html 且给 `graph` 时推送真实文件，内存包/outputPath 落盘同步；缺 graph 跳过并在 degradationNote 注明）。renderStarmap 纯 TS 确定性布局：章节为内侧同心轨道、概念为外侧黄金角星点、related 边按权重连线、prerequisite 虚线；HTML 为自包含内联 SVG。R11-1 起多图谱类型识别：experimental 八类实体分区环带（step_order 弧形连边）、industry 六类本体分区环带（五类关系各自线型）、fused 混合图产业侧橙色虚线边框区分 + 来源图例（fuseMeta 优先），均带类型中文名+计数图例；conceptual 输出逐字节不变。需输入含 `graph`（知识图谱）
- `videoFiles`：空数组（视频生成归特化技能，见出入点）

## 依赖
- 无硬性外部依赖

## 降级策略
无法生成视频或标准包时，仅导出 Markdown 讲稿与各语种字幕的最小包。实现语义：请求的 formats 含不支持项时，兜底为 `markdown+subtitles` 并标记 degraded；教学脚本为空时仅返回空包骨架并标记 degraded。说明：视频文件不属于本技能产出——数字人视频由特化技能 generate_digital_human_video 的制作清单承接（契约原文 videoFiles 字段保留为空数组，出入点记录于此）。

## 调用示例
```json
{
  "skillId": "export_course_package",
  "inputs": {
    "script": "$generate_teaching_script",
    "translations": "$translate_multilingual.multilingualTexts",
    "graph": "$extract_knowledge_graph",
    "options": { "formats": ["scorm", "markdown", "subtitles", "multilingual"], "packageName": "ml-basics" },
    "outZip": "dist/ml-basics.zip"
  }
}
```
