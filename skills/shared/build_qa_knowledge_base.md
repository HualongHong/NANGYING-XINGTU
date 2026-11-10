# 问答库构建（build_qa_knowledge_base）

## 技能 ID
`build_qa_knowledge_base`

## 中文名
问答库构建

## 类型
共享型（shared）

## 输入
- `knowledgeGraph`：课程知识图谱（extract_knowledge_graph 完整输出）
- `paragraphs`：原始课程段落（parse_course_material 输出的 paragraphs，问答语料来源）。说明：契约原文写作 `teachingScript`（教学讲稿），实现侧以原始段落为语料（覆盖定义型答案的原文定位）；教学脚本形态可由其下游产物替代。
- `ctx`（可选）：宿主注入上下文，可携带 `llm`（`LLMProvider`）启用自然问答改写

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "基于知识图谱与课程段落构建问答对、检索索引与意图标签"
inputs:
  - name: graph
    kind: object
    required: true
    aliases: ["knowledgeGraph"]
    hint: "extract_knowledge_graph 的完整输出"
    producer: ["extract_knowledge_graph"]
  - name: paragraphs
    kind: array
    required: true
    aliases: ["teachingScript"]
    hint: "parse_course_material 输出的 paragraphs 数组（问答语料来源）"
    producer: ["parse_course_material"]
```
## 输出
- `qaPairs`：问答对清单，每条 `{ id, question, answer, intent, conceptIds, sourceParagraph }`；intent ∈ `concept_definition`（定义型：什么是{X}）/ `concept_relation`（关系型：{X}和{Y}有什么关系）/ `procedure`（流程型：含顺序标记段落的流程问答）
- `retrievalIndex`：关键词倒排索引 `{ type: 'inverted', terms: Record<term, Array<{qaId, weight}>> }`（中文 2–4 字 n-gram + 英文词分词，权重=词频）；附 `search(kb, query, topK)` 纯函数（分词→倒排→权重求和排序，确定性）。向量检索仅留接口注释钩子，未实现
- `intentLabels`：意图标签枚举（上述三种）

## 依赖
- `vectorRetrieval`：向量检索（可选，未实现，仅注释钩子）
- `llm`：可选；注入时用段落改写生成更自然的问答（每段至少一条）

## 降级策略
- 无 LLM 注入时的模板问答（定义/关系/流程型）即默认实现，检索恒为关键词倒排索引——与契约"退化为关键词倒排索引"语义自洽。
- LLM 改写失败（返回非法内容或无有效问答）时，回落模板问答并标记 degraded。
- 图谱与段落均为空时，仅返回空问答库骨架并标记 degraded。

## 调用示例
```json
{
  "skillId": "build_qa_knowledge_base",
  "inputs": {
    "knowledgeGraph": "$extract_knowledge_graph",
    "paragraphs": "$parse_course_material.paragraphs"
  },
  "ctx": {
    "llm": "<宿主注入的 LLMProvider，可选>"
  }
}
```
