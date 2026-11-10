# 版面预览（render_preview）

## 技能 ID
`render_preview`

## 中文名
版面预览

## 类型
共享型（shared）

## 输入
- `file`：文件路径（docx/pptx/xlsx/pdf），或已解码对象 `{ content, materialType }`
- `detailLevel`（可选）：`'summary'`（类型+总览，默认）| `'outline'`（+标题大纲/页标题）| `'full'`（+截断文本预览）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "结构化版面预览：docx 标题大纲/表格统计、pptx 每页要点、pdf 文本层判定、扩展名与内容不符显著标注"
inputs:
  - name: file
    kind: any
    required: true
    hint: "文件路径（docx/pptx/xlsx/pdf），或已解码对象 { content, materialType }"
  - name: detailLevel
    kind: string
    required: false
    hint: "'summary'（默认）|'outline'（+大纲/页标题）|'full'（+截断文本预览）"
```

## 输出
- `fileType`：魔数判别的真实类型（docx/pptx/xlsx/pdf/unknown——PK 按 zip 内部 word/ppt/xl 判别）
- `claimedType` / `contentMismatch`：声明类型与真实类型交叉核验，**扩展名与内容不符时 contentMismatch=true 显著标注**（"文件与扩展名不符"痛点）
- `docx`：`{ outline（Heading 层级大纲）, paragraphs, tables（维度+表头首行）, sections }`
- `pptx`：`{ slides（每页 title/textItems/hasNotes）, imageCount, mediaCount }`
- `pdf`：`{ pages, charsPerPage, textLayer, totalImages, ocrSuggested（扫描件建议） }`
- `xlsx`：`{ sheets（name/rows/cols，dimension 解析） }`
- detailLevel=full 时各类型附 `previews`（截断文本）

## 依赖
- 无外部依赖（零成本结构解析；非真栅格化——沙箱内可运行，不受渲染依赖限制）

## 降级策略
- 无法识别的类型 → unavailable + 说明（不假装预览成功）
- 某类型内部解析失败 → 该项缺失并注明，其余类型正常

## 调用示例
```json
{
  "skillId": "render_preview",
  "inputs": { "file": "D:/课程/教案.docx", "detailLevel": "outline" }
}
```
