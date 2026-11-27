# 教学知识库检索（query_teaching_knowledge_base）

## 技能 ID
`query_teaching_knowledge_base`

## 中文名
教学知识库检索

## 类型
共享型（shared）

## 输入
- `query`：自然语言查询（概念名/问题/主题均可）。
- `kb`（可选）：KB artifact 对象（build_teaching_knowledge_base 输出，内存直传）。
- `kbId`（可选）：已落盘知识库标识（从 `.nangying-starmap/kb/<kbId>/kb.json` 加载）；与 `kb` 二选一，都缺时返回结构化错误。
- `topK`（可选）：返回证据条数上限（默认 5）。
- `budgetTokens`（可选）：证据包 token 预算（默认 2000；超出裁剪并如实报告条数）。
- `expand`（可选，默认 true）：图谱扩展——命中概念的先修/相关邻域证据以 via:'graph' 带出。

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "教学知识库检索（KAG 式混合检索）：倒排∪图谱扩展→确定性融合重排→token 预算→缺口报告；输出证据包（每条带出处/得分构成），六环节统一取材入口"
inputs:
  - name: query
    kind: string
    required: true
    hint: '自然语言查询（概念名/问题/主题）'
  - name: kb
    kind: object
    required: false
    hint: 'KB artifact 对象（build_teaching_knowledge_base 输出）'
    producer: [build_teaching_knowledge_base]
  - name: kbId
    kind: string
    required: false
    hint: '已落盘知识库标识（与 kb 二选一）'
  - name: topK
    kind: number
    required: false
    hint: '返回证据条数上限，默认 5'
  - name: budgetTokens
    kind: number
    required: false
    hint: '证据包 token 预算，默认 2000'
  - name: expand
    kind: boolean
    required: false
    hint: '图谱扩展（默认 true）：命中概念邻域证据以 via:graph 带出'
```

## 输出
- `evidencePack`：证据包——items（证据文本 + score + scoreParts{inverted/vector/graph/confidence} 得分构成 + via + 出处 citation/origin/材料/章节/段落）、concepts（命中概念含分层）、relations（命中概念间关系边）、stats（invertedHits/vectorHits/graphExpanded/truncatedByBudget/totalTokens 各级命中诚实报告）、coverageGaps（命中稀薄时的缺口概念+采集建议）、note（零命中/预算裁剪等诚实说明）。

## 依赖
纯本地确定性实现（同输入同输出，排序带 id tie-break）；向量召回为 R24 可选增强位（embedder 缺席自动纯倒排）。

## 降级策略
kb/kbId 都缺或 kbId 不存在 → 结构化错误（INVALID_INPUT + 下一步引导）；库内无命中证据 → 空 items + coverageGaps + 采集建议（绝不硬答）；token 预算裁剪如实报告条数；加载的 kb 先过 schema 校验，违规即 degraded 标注。

## 调用示例
```json
{
  "skillId": "query_teaching_knowledge_base",
  "inputs": { "kbId": "kb-abc123", "query": "光反应与碳反应的关系", "topK": 5 }
}
```
内存直传：
```json
{
  "skillId": "query_teaching_knowledge_base",
  "inputs": { "kb": "$build_teaching_knowledge_base.knowledgeBase", "query": "比色皿 使用", "budgetTokens": 1500 }
}
```
