# 智慧课程结构设计（design_course_structure）

## 技能 ID
`design_course_structure`

## 中文名
智慧课程结构设计

## 类型
共享型（shared）

## 输入
- `knowledgeGraph`：extract_knowledge_graph 输出的完整课程知识图谱（本技能消费其全部四个字段，而非仅 prerequisiteGraph 子图）
- `teachingObjectives`：结构化教学目标 `{ audience: string; totalMinutes?: number; objectives?: string[] }`；`totalMinutes` 为课程总时长约束（分钟），缺省时按内容量自由估算
- `priorKnowledge`（可选）：先备知识——学生已掌握的概念（标签或节点 ID）；命中概念保留在先修链引用中但不进本课测评点（`lesson.priorConceptIds` 标注）
- `courseType`（可选）：课型 `'lecture'|'lab'|'hybrid'`（讲授/实验/混合）——影响环节模板比例（实验课练习环节加量）；缺省 lecture，行为与旧版一致
- `deliverables`（可选）：交付物清单，回声进 `courseScript.deliverables` 供下游导出对齐
- `ctx`（可选）：宿主注入上下文，可携带 `llm`（`LLMProvider`）启用结构增强（模块命名、课时目标、衔接语）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "基于知识图谱与教学目标生成课程脚本、教学结构与授课流程"
inputs:
  - name: graph
    kind: object
    required: true
    aliases: ["knowledgeGraph"]
    hint: "extract_knowledge_graph 或 fuse_knowledge_graphs 的输出（JSON 字符串会自动解析）"
    producer: ["extract_knowledge_graph", "fuse_knowledge_graphs"]
  - name: objectives
    kind: object
    required: true
    aliases: ["teachingObjectives"]
    hint: "教学目标 { audience: string; totalMinutes?: number; objectives?: string[] }"
  - name: priorKnowledge
    kind: array
    required: false
    hint: "先备知识：学生已掌握的概念（标签或节点 ID）；保留在先修链引用中但不进测评点（lesson.priorConceptIds 标注）"
  - name: courseType
    kind: string
    required: false
    hint: "课型：'lecture'（讲授，默认）|'lab'（实验：练习环节加量）|'hybrid'（混合）；缺省行为与旧版一致"
  - name: deliverables
    kind: array
    required: false
    hint: "交付物清单（如 [\"讲义\",\"习题册\"]）：回声进 courseScript.deliverables，供下游导出对齐"
```
## 输出
- `courseScript`：课程总体脚本（标题、受众、总时长、模块编排与时间分配）
- `teachingStructure`：教学结构，模块 → 课时 → 环节三级：
  - 模块 = 章节层级树根节点，模块名由章节标题派生（LLM 可增强）；
  - 课时引用上游图谱节点 ID（`sectionIds` / `conceptIds`，沿用 extract_knowledge_graph 的确定性 `sec-`/`con-` ID，星图可追溯），含时长估算、固定五环节模板（导入→讲解→示例→练习→小结）、测评点（覆盖知识点标签）；
  - 课时目标与衔接语为 LLM 增强产物（启发式输出中缺省）。
- `teachingFlow`：授课流程（全部环节的顺序步骤与衔接边）

## 依赖
- 无硬性外部依赖（图谱来自上游技能）；`llm` 可选，仅用于增强

## 降级策略
- 启发式默认实现即模板化编排（模块=章节树根、课时=章节、五环节模板），语义与"模板化结构"自洽。
- 无知识图谱输入或图谱为空时，退化为模板化结构骨架：单模块单课时"课程总览"，按 导入—讲解—练习—总结 四环节切分总时长（等级标记 degraded）。
- 宿主注入的 LLM 增强失败（返回非法内容、长度不匹配或解析异常）时，自动回落启发式结构并标记 degraded。

## 调用示例
```json
{
  "skillId": "design_course_structure",
  "inputs": {
    "knowledgeGraph": "$extract_knowledge_graph",
    "teachingObjectives": { "audience": "本科生", "totalMinutes": 90 }
  },
  "ctx": {
    "llm": "<宿主注入的 LLMProvider，可选>"
  }
}
```
