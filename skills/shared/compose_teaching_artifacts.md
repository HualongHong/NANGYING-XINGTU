# 教学四件套组装（compose_teaching_artifacts）

## 技能 ID
`compose_teaching_artifacts`

## 中文名
教学四件套组装

## 类型
共享型（shared）

## 输入
- `selected`（必填）：`select_research_evidence` 输出的 selected（`[{ recordId, title, section, score?, mustReview? }]`）
- `records`（可选）：记录详情数组（含 `excerpt`/`commentary`/`thinkQuestions` 的原文节选与教学解说；缺省给来源字段，节选/解说标占位待补）
- `courseStructure`（可选）：`design_course_structure` 输出（消费 `sections[].title` 的节序）——编号按课程节顺序定义；缺省按 selected 中节名首次出现序
- `studentDrafts`（可选）：agent 已起草的学生产物文本 `{ slides?, reading?, html? }`——送 H1 信息边界校验（教师数据 token 命中即违规）
- `teacherLayer`（可选）：教师数据层（教学目标/学情/设计理由/评分锚点/参考答案/追问话术）——只进教案产物，校验目标是它**不**出现在学生产物
- `venue` / `year`（可选）：会议/出版物名称与年份（取自摘要集封面/版权页，**不假定**）
- `baseline`（可选）：已验收基线指标（如 `{ caseCount, sections }`）——增量加工时 diff，变化项列出须显式确认（A4 增量不破坏）
- `extraTeacherTokens`（可选）：追加的教师专属 token（禁用词表扩展）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "选文源+课程结构+教师数据层 → 四件套内容源：编号单一来源（案例=阅读编号、按节序）+ 来源字段渲染 + H1 信息边界校验 + 基线 diff"
inputs:
  - name: selected
    kind: array
    required: true
    hint: "select_research_evidence 输出的 selected [{ recordId, title, section, score?, mustReview? }]"
    producer: ["select_research_evidence"]
  - name: records
    kind: array
    required: false
    hint: "记录详情（authors/keywords/physicalPages/printedPage/session/excerpt/commentary/thinkQuestions）：缺省只渲染来源字段，节选/解说标占位"
  - name: courseStructure
    kind: object
    required: false
    hint: "design_course_structure 输出（消费 sections[].title 节序）：编号按课程节顺序；缺省按节名出现序"
    producer: ["design_course_structure"]
  - name: studentDrafts
    kind: object
    required: false
    hint: "agent 起草的学生产物文本 { slides?, reading?, html? }：送 H1 校验（教师 token 命中即违规）"
  - name: teacherLayer
    kind: object
    required: false
    hint: "教师数据层（教学目标/评分锚点/参考答案…）：只进教案，校验目标是不泄漏进学生产物"
  - name: venue
    kind: string
    required: false
    hint: "会议/出版物名称（取自摘要集，不假定）"
  - name: year
    kind: string
    required: false
    hint: "年份（取自封面/版权页，不假定）"
  - name: baseline
    kind: object
    required: false
    hint: "已验收基线指标 { caseCount?, sections? }：增量加工 diff，变化项须显式确认"
  - name: extraTeacherTokens
    kind: array
    required: false
    hint: "追加教师专属 token（禁用词表扩展）"
```

## 输出
- `artifacts`：四件套内容源表示（按节）——`slides`（研究例证帧位+引入标签说明）、`reading`（原文/解读配对项 `{ caseNo, sourceField, excerptReady, commentaryReady, thinkCount }`）、`html`（案例速查卡+自测位）、`lessonPlan`（教师数据层承载位）
- `numberingMap`：编号单一来源映射 `[{ caseNo, recordId, section, title, mustReview }]`——**案例编号=阅读编号、按课程节顺序**（3.10），四产物与教案由同一份源渲染，禁止手工对齐
- `sourceFields`：`{ caseNo: 来源字段行 }`——统一模板（7.3）：`[阅读编号 NN] 作者. 题名. 会议/出版物, 年份: 印刷页 P（分会场；PDF 第 P+Δ 页）. 链接或 DOI：未提供.`，缺失一律「未提供」不补造（H2）
- `violations`：H1 信息边界违规 `[{ artifact, token, count }]`——学生产物出现教师数据 token 即列出，命中须清零
- `baselineDiff`：基线变化项（增量加工确认用）
- `degraded`：selected 为空（无选文）
- `notes`：必复核篇数、缺节选/解说篇数、基线变化提醒

## Agent 执行协议（技能正文）
1. **分层撰写**（4.1）：选文源/主干/深化层/教师数据层各自成层，术语、节号、案例编号、来源格式只在源里定义一次；渲染器（课件/阅读/HTML/教案）只读各层，不自行定义术语编号。
2. **解读页五段式**（K4）：这一篇在问什么 → 对应本章原理 → 方法与证据 → 与前沿方向衔接 → 「想一想」1–2 道（尽量用本章概念解释）。
3. **易错点三处同表述**（K5）：同一条纠偏在课件拓展页、讲册易错点、材料解读页字面一致。
4. **深化只做增量**（K6）：新增页放节末/小结前，不插入原有讲解中间；公式术语沿用课件原记号，不引入第二套符号。
5. **增量不破坏**（A4）：每轮追加不新增结构、不改已验收指标；先备份再加工；baselineDiff 非空时停下来向用户确认。
6. **不替用户假定**：会议名称/年份/作者不编造；不补造 DOI/URL/出版社/卷期。

## 依赖
无外部平台。正文撰写属宿主 agent 能力；本技能保证编号/来源/边界的确定性，无 LLM 也能产出骨架（节选/解说标占位待补）。

## 降级策略
- 无 LLM/未起草正文：输出确定性骨架 + 占位标记（`excerptReady:false`、`quizPlaceholder:true`），占位诚实可审，由 `audit_teaching_package` 的占位符扫描兜底。
- 记录详情缺失：来源字段如实标「未提供」，不编造（H2）。
- selected 为空：degraded + 空骨架；输入非法（selected 缺失/无节）返回结构化错误。

## 调用示例
```json
{
  "skillId": "compose_teaching_artifacts",
  "inputs": {
    "selected": "$select_research_evidence.selected",
    "records": "$parse_abstract_collection.records",
    "courseStructure": "$design_course_structure",
    "venue": "中国生态学大会摘要集",
    "year": "2026",
    "studentDrafts": { "html": "<html>……</html>" },
    "baseline": { "caseCount": 14 }
  }
}
```
