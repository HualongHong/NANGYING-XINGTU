# 摘要集解析（parse_abstract_collection）

## 技能 ID
`parse_abstract_collection`

## 中文名
摘要集解析

## 类型
共享型（shared）

## 输入
- `materialFile`（与 pages/content 二选一）：文件路径（适配层读取解码），或已解码对象 `{ content, materialType, pages? }`
- `pages`（可选）：分页文本数组（第 i 元素 = PDF 第 i+1 物理页文本，pdftotext 分页直出）——**有分页才能做页号偏移探测**
- `content`（可选）：纯文本，含 `\f`（pdftotext 分页符）时自动切段为 pages
- `records`（可选）：调用方/LLM 预切分记录数组（自动切分不满意时的归一化路径，字段缺失给安全缺省）
- `entryPattern`（可选）：条目起始行正则字符串（从目录页式样观察，如 `^\d{4}` 编号开头），提供后逐行命中切分条目
- `sessionHints`（可选）：分会场/栏目标题提示词数组（内置：分会场/专题/专场/Session/论坛/报告会）
- `declaredTotal`（可选）：摘要集自述收录篇数（封面/版权页）——算解析覆盖率，差额如实写交付说明，不强行补齐
- `workspaceRoot`（可选）：materialFile 为相对路径时优先相对它解析
- `async`（可选）：`true` 时提交异步作业、毫秒级返回 jobId，用 `manage_async_tasks` 轮询（不受宿主超时限制）——大摘要集（数百页）建议走异步

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "会议摘要集 → 结构化记录（题名/作者/单位/关键词/正文/分会场/物理页+印刷页）+ 页号偏移探测 + 抽取缺陷旗标 + 解析覆盖率"
inputs:
  - name: materialFile
    kind: any
    required: false
    hint: "文件路径字符串，或已解码对象 { content, materialType, pages? }；与 pages/content 二选一"
  - name: pages
    kind: array
    required: false
    hint: "分页文本数组（pdftotext 分页直出）：有分页才能做页号偏移 Δ 探测与跨页条目合并"
  - name: content
    kind: string
    required: false
    hint: "纯文本；含 \f 分页符时自动切段；单段时偏移探测报 unavailable"
  - name: records
    kind: array
    required: false
    hint: "预切分记录 [{ title, authors?, affiliations?, keywords?, body, session?, physicalPage?/printedPage? }]，归一化路径"
  - name: entryPattern
    kind: string
    required: false
    hint: "条目起始行正则（依目录页式样，如 ^\\d{4}）：逐行命中切分；缺省且未给 records 时只出分会场归属+偏移探测（degraded）"
  - name: sessionHints
    kind: array
    required: false
    hint: "分会场标题提示词（内置 分会场/专题/专场/Session/论坛/报告会）"
  - name: declaredTotal
    kind: number
    required: false
    hint: "摘要集自述收录篇数：输出解析覆盖率，差额写交付说明不强行补齐"
  - name: workspaceRoot
    kind: string
    required: false
    hint: "materialFile 相对路径解析根目录（MCP 子进程 cwd 与宿主工作区不一致时必传）"
  - name: async
    kind: boolean
    required: false
    hint: "true 时提交异步作业、毫秒级返回 jobId，用 manage_async_tasks 轮询（不受宿主超时限制）；大摘要集建议走异步"
```

## 输出
- `records[]`：`{ id, title, authors, affiliations, keywords, body, session, physicalPages: [from,to], printedPage?, status, defects[] }`——`printedPage = 物理页 − Δ`（分段/不可探测时按段换算或缺省，来源标注须说明）
- `sessions[]`：分会场/栏目清单（按出现顺序）
- `pageOffset`：`{ kind: 'constant', delta } | { kind: 'segmented', segments[] } | { kind: 'unavailable', reason }`——**Δ 是探测值不是常量**（方法论 3.4）
- `coverage`：`{ parsed, declaredTotal?, ratio? }`——可解析条数 vs 自述收录数
- `defects` 旗标（方法论 3.8/6 F11，命中即如实标注，供「必复核」）：`title_eats_author`（题名超长、末尾人名序列）、`cross_page_break`（正文无终止标点，跨页断裂）、`keywords_in_body`（关键词行 >100 字）、`affiliation_missing`、`title_missing`
- `degraded`：无 entryPattern 且无预切分记录（只完成分会场归属+偏移探测）

## Agent 执行协议（技能正文）
1. **双模式交叉抽取**（经验 B2）：`pdftotext -layout` 与 `-raw` 各抽一遍；文本层错位（编号散落、短行异常、语句不通）时两种都交本技能对比，人工校序后照录，并在成品页底注明校正。
2. **条目式样从目录页观察**：先抽封面/目录页确定分会场起始印刷页与条目编号式样，再定 `entryPattern`；扫描件先声明 OCR 降级——「来源字段可核验」降级为「需人工逐项复核」。
3. **校正纪律**：校正清单只处理排版与抽取错误，**不改数字、单位、措辞**；每条校正留痕。
4. **覆盖率缺口如实报告**：跨页断裂、特殊版式、封面目录页造成的差额写进交付说明，不强行补齐。

## 依赖
无外部平台；分页文本由适配层/调用方提供（本插件 PDF 解码链或宿主 pdftotext）。

## 降级策略
- 无 pages（纯文本单段）：偏移探测报 `unavailable`，记录切分照常——来源标注只给物理页。
- 无 entryPattern 且无 records：`degraded`，只出分会场归属+偏移探测+覆盖率，不编造记录。
- 输入非法（正则不合法、declaredTotal 非正整数等）返回结构化错误；预切分记录字段缺失给安全缺省（缺题名标 `incomplete`）。

## 调用示例
```json
{
  "skillId": "parse_abstract_collection",
  "inputs": {
    "materialFile": "/data/生态学大会摘要集.pdf",
    "entryPattern": "^\\d{4}\\s",
    "declaredTotal": 1024
  }
}
```
预切分路径（LLM 先切，本技能归一化+算页码）：
```json
{
  "skillId": "parse_abstract_collection",
  "inputs": {
    "pages": ["<第1物理页文本>", "<第2物理页文本>"],
    "records": [{ "title": "放牧对草原稳定性的影响", "authors": ["张三", "李四"], "body": "……", "physicalPage": 47 }]
  }
}
```
