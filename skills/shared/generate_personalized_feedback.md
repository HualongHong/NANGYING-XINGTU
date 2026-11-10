# 个性化反馈（generate_personalized_feedback）

## 技能 ID
`generate_personalized_feedback`

## 中文名
个性化反馈

## 类型
共享型（shared）

## 输入
- `quiz`：测验结果（结构化形态，契约中 quizResults 的明确形式）：`{ learnerId?, answers: [{ conceptId, correct, questionId? }] }`——按概念逐题作答记录（quiz 模式与 graph 配套；与 freeTextReport 二选一，可并存）
- `graph`：课程知识图谱（extract_knowledge_graph 完整输出，用于定位薄弱概念与先修根因；quiz 模式必需）
- `qaKnowledgeBase`（可选）：问答库（build_qa_knowledge_base 输出），用于生成补救练习建议
- `freeTextReport`（可选）：学生实验报告等自由文本——产出段落级反馈 `freeTextFeedback`（每段摘录/评语/待改进点）；LLM 可用时精炼评语，否则模板降级
- `ctx`（可选）：宿主注入上下文，可携带 `llm`（`LLMProvider`）生成自然语言评语

说明：契约原文输入为 `learningBehavior`（学习行为数据）+ `quizResults`；实现侧首切片以结构化测验作答（`quiz`）为主要输入，行为数据字段（观看时长/回放等）留待后续版本接入。

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "根据测验结果与知识图谱生成个性化反馈与补救练习建议"
inputs:
  - name: quiz
    kind: object
    required: false
    aliases: ["quizResults"]
    hint: "测验结果 { learnerId?, answers: [{ conceptId, correct, questionId? }] }（与 freeTextReport 二选一，可并存；quiz 模式 graph 必需）"
  - name: graph
    kind: object
    required: false
    aliases: ["knowledgeGraph"]
    hint: "extract_knowledge_graph 或 fuse_knowledge_graphs 的输出（JSON 字符串会自动解析；quiz 模式必需）"
    producer: ["extract_knowledge_graph", "fuse_knowledge_graphs"]
  - name: qaKnowledgeBase
    kind: object
    required: false
    hint: "build_qa_knowledge_base 的输出，用于生成补救练习建议"
    producer: ["build_qa_knowledge_base"]
  - name: freeTextReport
    kind: string
    required: false
    hint: "学生实验报告等自由文本：产出段落级反馈（freeTextFeedback），LLM 可用时精炼评语，否则模板降级"
```
## 输出
- `feedback`：总体评价文本（LLM 评语或模板评语：得分档 + 薄弱知识点列表）
- `suggestions`：针对性建议数组 `[{ kind, conceptIds, text }]`，kind ∈ `review_concept`（复习薄弱概念）/ `prerequisite_repair`（先修基础回炉）/ `qa_practice`（推荐问答练习）/ `path_hint`（按先修拓扑的复习次序）
- `conceptAnalysis`：按概念分组的表现分析 `[{ conceptId, label, total, correct, accuracy, weak, weakPrerequisites }]`（薄弱阈值 60%；`weakPrerequisites` = 同为薄弱的先修概念，即根因追溯结果）
- `overall`：`{ total, correct, accuracy, band }`，band ∈ `excellent`(≥85%) / `pass`(≥60%) / `weak`

## 依赖
- `llm`：可选；仅用于生成自然语言评语

## 降级策略
启发式默认实现即契约"通用模板反馈"语义：按概念正确率套用固定评语模板，建议退化为指向薄弱概念及其先修。LLM 评语生成失败时回落模板并标记 degraded；无作答记录时返回提示文本。

## 调用示例
```json
{
  "skillId": "generate_personalized_feedback",
  "inputs": {
    "quiz": { "learnerId": "stu-01", "answers": [{ "conceptId": "con-b", "correct": false }] },
    "graph": "$extract_knowledge_graph",
    "qaKnowledgeBase": "$build_qa_knowledge_base"
  },
  "ctx": {
    "llm": "<宿主注入的 LLMProvider，可选>"
  }
}
```
