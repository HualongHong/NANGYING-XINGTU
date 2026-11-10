# 产业图谱（build_industry_graph）

## 技能 ID
`build_industry_graph`

## 中文名
产业图谱

## 类型
共享型（shared）

## 输入
- `sections`：sections+fields 形态（与 text 二选一）——`[{ id?, title, fields: { 产业链环节/岗位/工作任务/技能要求/工具/趋势: 值或数组 } }]`；每个 section = 一个产业（产业链环节）节点
- `fieldMap`（可选）：字段键名映射 `{ 用户键: industry|occupation|workTask|skill|tool|trend }`（别名：产业链/职位/职责/能力要求/技术/政策…自动识别）
- `text`：自由文本形态（与 sections 二选一）——岗位 JD / 教学标准 / 招聘启事；LLM 注入时抽取为产业实体，无 LLM 回落词面启发式（岗位词典后缀 + 熟悉/掌握→skill、负责/承担→task 动词短语模式），level=degraded 诚实标注

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "产业图谱构建（产教图谱第三张图谱）：产业链环节/岗位/任务/技能/工具/趋势六类本体，关联课程知识图谱做就业对齐"
inputs:
  - name: sections
    kind: array
    required: false
    hint: "sections+fields 形态：[{ id?, title, fields: { 产业链环节/岗位/工作任务/技能要求/工具/趋势: 值或数组 } }]（与 text 二选一）"
  - name: fieldMap
    kind: object
    required: false
    hint: "字段键名映射：{ 用户键: industry|occupation|workTask|skill|tool|trend }"
  - name: text
    kind: string
    required: false
    hint: "自由文本形态：岗位 JD/教学标准/招聘启事（LLM 抽取，无 LLM 词面启发式 degraded；词面路径按句子级共现建边，边权重=共现句数）"
  - name: lexicalWindow
    kind: number
    required: false
    hint: "词面层共现窗口（相邻句数，0=仅同句，最大 3，缺省 0）；text 形态词面路径生效：岗位-技能/任务须同句或相邻句共现才建边"
```

## 输出
课程知识图谱骨架（与 extract 同构，fuse/diff/render_preview 直接兼容）：
- `entities`：产业实体（`nodeType` ∈ industry/occupation/workTask/skill/tool/trend；确定性 ID `ind-<hash>`）
- `relations`：`industry_has_occupation / occupation_has_task / task_requires_skill / skill_uses_tool / trend_drives_skill`
- `stats.byType`：各类型实体计数；`schemaVersion: "1.2"`
- `level`：sections 形态恒 full；text 形态 LLM 成功 full，词面回落 degraded

## 依赖
- 无强制外部依赖；text 形态的实体抽取以 LLM 为佳（无 LLM 词面启发式，粒度有限并诚实标注）

## 降级策略
- sections/text 均缺或形态非法 → unavailable + INVALID_INPUT + 最小示例
- text 形态无 LLM 或 LLM 抽取失败 → degraded：词面启发式（岗位词典 + 动词短语模式）
- 词面启发式零命中 → unavailable（建议改 sections 形态或注入 LLM）

## 调用示例
```json
{
  "skillId": "build_industry_graph",
  "inputs": {
    "sections": [{
      "id": "bio-med",
      "title": "生物医药检测",
      "fields": {
        "岗位": ["体外诊断试剂研发工程师", "质量控制专员"],
        "工作任务": ["试剂配方开发与验证", "分析方法学转移"],
        "技能要求": ["酶动力学参数测定", "分光光度法", "GLP 规范"],
        "工具": ["酶标仪", "紫外分光光度计"],
        "趋势": ["体外诊断行业扩容", "监管趋严"]
      }
    }]
  }
}
```
