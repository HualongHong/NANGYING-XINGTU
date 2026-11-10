# 产教关联（link_knowledge_industry）

## 技能 ID
`link_knowledge_industry`

## 中文名
产教关联

## 类型
共享型（shared）

## 输入
- `courseGraph`：课程知识图谱（extract/fuse 输出；experimental 实验图谱的 nodes 形态亦兼容）
- `industryGraph`：产业图谱（#28 `build_industry_graph` 的输出）
- `jobPostings`（可选）：原始招聘文本字符串数组——现场抽取补充产业侧实体后再关联（LLM 优先，词面回落）
- `maxLinksPerNode`（可选）：LLM 语义层每课程实体的最大关联扇出（默认 5）
- `glossary`（可选）：术语库——命中术语加强词面匹配

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "知识点↔产业需求三层关联（词面/LLM/聚合）：供需缺口报告、课程覆盖冗余、按岗位聚合"
inputs:
  - name: courseGraph
    kind: object
    required: true
    hint: "课程知识图谱（extract/fuse 输出；experimental nodes 形态兼容）"
    producer: ["extract_knowledge_graph", "fuse_knowledge_graphs"]
  - name: industryGraph
    kind: object
    required: true
    hint: "产业图谱（#28 build_industry_graph 输出）"
    producer: ["build_industry_graph"]
  - name: jobPostings
    kind: array
    required: false
    hint: "原始招聘文本字符串数组：现场抽取补充产业侧实体后再关联"
  - name: maxLinksPerNode
    kind: number
    required: false
    hint: "LLM 语义层每课程实体最大扇出（默认 5）"
  - name: glossary
    kind: any
    required: false
    hint: "术语库对象（命中术语加强词面匹配）"
```

## 输出
- `links` / `matched`：关联清单 `[{ from（课程实体 id）, to（产业实体 id）, type（maps_to_skill|supports_task|needed_by_occupation）, confidence, evidence, source（lexical|llm） }]`；matched 附课程实体 source 出处（呼应 R3 溯源）
- `gaps`：供需缺口——产业要求 skill/task 但课程未覆盖，按 heat（关联岗位数）排序，`{ industryEntityId, label, type, demandedByOccupations, heat, suggestion: "建议补充教学点：X" }`
- `coverage`：课程冗余提示——零产业关联的课程实体（含 source 出处）
- `stats`：`{ lexical, llm, gaps, coverage }`

## 依赖
- 词面层永远可用（确定性）；LLM 语义层以宿主注入为最佳（失败/超时回落词面层并标 degraded）

## 降级策略
- 缺 courseGraph/industryGraph → unavailable + INVALID_INPUT
- LLM 失败 → degraded：词面层结果 + 诚实说明；未注入 LLM → 词面层 full + 说明
- jobPostings 抽取失败 → 该帖按词面回落并在 note 标注

## 调用示例
```json
{
  "skillId": "link_knowledge_industry",
  "inputs": {
    "courseGraph": "<extract_knowledge_graph 输出>",
    "industryGraph": "<build_industry_graph 输出>",
    "jobPostings": ["体外诊断试剂研发工程师：要求熟悉酶动力学参数测定、分光光度法、GLP 规范……"]
  }
}
```
