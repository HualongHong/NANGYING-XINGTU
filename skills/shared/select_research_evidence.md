# 研究例证选文（select_research_evidence）

## 技能 ID
`select_research_evidence`

## 中文名
研究例证选文

## 类型
共享型（shared）

## 输入
- `records`（必填）：候选记录数组（`parse_abstract_collection` 输出的 records：`{ id, title, keywords, body, affiliations, session, defects }`）
- `sections`（必填）：章节知识结构 `[{ title, knowledgePoints, keyPoints?, confusables?, declaredNoHit? }]`——`title`=节名，`knowledgePoints`=知识点标签（核心词直取来源，**词族不是内置学科词表**），`keyPoints`=重点知识点（收敛条件 1 要求每个重点至少 1 条证据，缺省取 knowledgePoints），`confusables`=易混概念（→排除词），`declaredNoHit`=无可靠命中声明（K2：宁可留白注明以教材为准）
- `families`（可选）：预派生词族 `[{ section, core[], expansion[], exclusion[] }]`——缺省时启发式直取（core=知识点标签，expansion 留空）；执行器在 ctx.llm 存在时自动 LLM 派生并入
- `weights`（可选）：字段权重 `{ title?, keyword?, body?, affiliation? }`，默认 `{3, 2, 1, 0.5}`（一般题名>关键词>正文>单位/分会场，**初值为建议值可改**）
- `percentile`（可选）：相对分位阈值 `(0,1]`，默认 `0.2`（前 20%）——**用相对分位不用绝对分数线**（3.5：不同摘要集规模与学科词频差异极大，绝对分数线不可移植）；规模小取较大比例、规模大取较小比例
- `perSectionMin`（可选）：每节至少入选条数（非负整数，默认 1）——覆盖面约束优先于总分

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "从摘要集记录中按章节知识点选研究例证：词族加权评分 + 相对分位阈值 + 覆盖优先 + 复核记录 + 收敛四条件"
inputs:
  - name: records
    kind: array
    required: true
    hint: "parse_abstract_collection 输出的 records（id/title/keywords/body/affiliations/session/defects）"
    producer: ["parse_abstract_collection"]
  - name: sections
    kind: array
    required: true
    hint: "[{ title, knowledgePoints, keyPoints?, confusables?, declaredNoHit? }]：节名+知识点标签（核心词直取）+易混概念（排除词）"
  - name: families
    kind: array
    required: false
    hint: "预派生词族 [{ section, core[], expansion[], exclusion[] }]；缺省启发式 core=知识点标签，LLM 在场自动派生并入"
  - name: weights
    kind: object
    required: false
    hint: "字段权重 { title?, keyword?, body?, affiliation? }，默认 {3,2,1,0.5}（建议值可改）"
  - name: percentile
    kind: number
    required: false
    hint: "相对分位阈值 (0,1]，默认 0.2：不用绝对分数线；建议值按摘要集规模调整"
  - name: perSectionMin
    kind: number
    required: false
    hint: "每节至少入选条数（默认 1）：覆盖不足时放宽该节阈值补入并标必复核，不让热门主题挤满名单"
```

## 输出
- `candidates`：全部得分候选（按分排序）`{ recordId, title, section, score, percentile, matchedCore, matchedExpansion, matchedExclusion, sourceComplete, defects }`
- `selected`：入选 `[{ ...candidate, mustReview }]`——`mustReview=true` 表示覆盖面补入（低于阈值）、排除词命中或抽取缺陷，**必须人工复核后才可进课堂正文**（3.6）
- `rejected`：落选留痕 `{ recordId, title, section, reason }`——低于相对分位阈值 / 排除词降权 / 题名重复（保留高分者），供「为什么选了这篇、没选那篇」复盘
- `reviewQueue`：复核记录表（附录 F 字段：候选编号/得分分位/对应节/选落选/理由/来源是否齐全）——每篇记「选/不选+理由」落盘留存
- `convergence`：收敛四条件（3.7）`{ met, conditions[] }`——①每个重点知识点 ≥1 条可对应证据 ②每一节有落位（或无命中声明）③无重复主题占位 ④来源字段齐全。**数量由覆盖度决定，不设固定上限、不设凑数下限**；不满足时回到词族扩展（3.2）或调阈值（3.5），而不是随便补篇数
- `stats`：`{ scored, selected, mustReview, perSection }`
- `termFamilyNote`（LLM 在场时）：词族派生并入结果说明（如「LLM 词族已并入 3/3 节」）；派生失败给回落说明（核心词兜底，可经 `families` 入参手工补扩展词）

## Agent 执行协议（技能正文）
1. **复核判据**（3.6，mustReview 与全部课堂正文条目必过）：①结论真的对应本节某个概念而非仅学科相同 ②结论带明确条件（体系/尺度/方法/剂量）③数字与单位可核验 ④来源字段齐全 ⑤能作类比而不被外推成定量结论。常见淘汰原因：测量对象不是本节概念、无条件句、来源残缺、纯方法学展示。
2. **主次关系比数字更容易错**（K3）：含比较级/因果/独占性判断的入选条目，回原文逐字核对（如「主要驱动/进一步促进」不得转述反）。
3. **无可靠命中就不硬套**（K2）：种-面积曲线等概念无可信量化支撑时保留教材原讲解、页脚注明「以教材与本课件原讲解为准」——用 `declaredNoHit` 声明。
4. **节选纪律**（3.9）：每篇只节选与本节最相关的连续段落，明确标注节选不伪装全文；解读页与原文页物理相邻。

## 依赖
- 可选：`ctx.llm`——词族派生（同义/上下位/相关过程名/测量量/方法名 + 同名异义排除词）；LLM 失败或缺席回落启发式（核心词直取），不编造扩展词，行为可复现。

## 降级策略
- 无 LLM：核心词=知识点标签直取 + `confusables` 排除词，全流程行为一致（仅召回面变窄，`convergence` 如实给未覆盖清单）。
- 全部记录对所有词族零命中：返回空选 + 收敛条件 1 未达 + 指引回词族扩展/放宽阈值，**不凑数、不硬套**。
- 输入非法（sections/records 缺失、percentile 越界、weights 负值）返回结构化错误（含缺失项与最小示例）。

## 调用示例
```json
{
  "skillId": "select_research_evidence",
  "inputs": {
    "records": "$parse_abstract_collection.records",
    "sections": [
      { "title": "3.1 土壤质地", "knowledgePoints": ["质地分类", "砂粒黏粒"], "confusables": ["地质质地"] },
      { "title": "3.2 土壤结构", "knowledgePoints": ["团粒结构"], "keyPoints": ["团粒结构"], "declaredNoHit": false }
    ],
    "percentile": 0.2,
    "perSectionMin": 1
  }
}
```
