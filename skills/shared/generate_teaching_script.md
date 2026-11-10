# 教学脚本生成（generate_teaching_script）

## 技能 ID
`generate_teaching_script`

## 中文名
教学脚本生成

## 类型
共享型（shared）

## 输入
- `courseStructure`：design_course_structure 输出的完整课程结构（消费 teachingStructure 的模块→课时→环节三级结构）
- `style`（可选）：风格参数 `{ language?: string; verbosity?: 'brief' | 'standard' | 'detailed' }`；详略度控制口播模板句式数量
- `sourceText`（可选）：讲义原文直传——讲解/示例/小结环节口播优先引用原文命中句（"原文参考：…"），减少模板化填空句；LLM 改写时原文摘录进提示词保证术语与事实一致
- `requiredConcepts`（可选）：必含知识点清单（概念标签）——输出附 `coverage` 覆盖报告 `{ requiredConcepts, coveredConcepts, missingConcepts }`，未覆盖项如实标注
- `ctx`（可选）：宿主注入上下文，可携带 `llm`（`LLMProvider`）启用口播稿改写增强

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "依据课程结构生成分镜讲稿、口播稿与字幕稿三稿"
inputs:
  - name: structure
    kind: object
    required: true
    aliases: ["courseStructure"]
    hint: "design_course_structure 的输出（消费 teachingStructure 三级结构）"
    producer: ["design_course_structure"]
  - name: style
    kind: object
    required: false
    hint: "{ language?: string; verbosity?: 'brief'|'standard'|'detailed' }"
  - name: sourceText
    kind: string
    required: false
    hint: "讲义原文直传：讲解/示例/小结环节口播优先引用原文命中句（原文参考：…），减少模板化填空；LLM 改写时原文摘录进提示词保持一致"
  - name: requiredConcepts
    kind: array
    required: false
    hint: "必含知识点清单（概念标签）：输出 coverage 覆盖报告（required/covered/missing），标注未覆盖项"
```
## 输出
三种成稿由同一组分镜 scene 派生（字幕与口播同源，字幕 = 口播按 scene 的时间切片文本）：
- `storyboardScript`：分镜讲稿，每课时一组 scene：`{场景类型（标题卡/PPT展示/教师口播/示例演示/练习/小结）、画面提示、口播稿、字幕稿、预计时长、课时内起始分钟、涉及的知识点 ID（上游确定性 ID）}`
- `voiceoverScript`：口播稿，按 scene 顺序拼接的纯语音朗读文本
- `subtitleScript`：字幕稿，带时码建议（起始分钟 + 时长）的 cue 列表
- `coverage`（`requiredConcepts` 提供时）：必含知识点覆盖报告 `{ requiredConcepts, coveredConcepts, missingConcepts }`——未覆盖项如实标注，供调用方决定是否补充结构或调整清单

## 依赖
- `llm`：大语言模型（可选；注入时把模板口播稿改写为连贯讲授语言）

## 降级策略
- 启发式默认实现即产出模板化口播稿 + 基础分镜/字幕，超出契约原文"纯文本讲稿无分镜"的最低描述（约定扩展）。
- 宿主注入的 LLM 改写失败（返回非法内容、长度不匹配或解析异常）时，自动回落启发式模板稿并标记 degraded。
- 课程结构为空时退化为空脚本并标记 degraded。

## 调用示例
```json
{
  "skillId": "generate_teaching_script",
  "inputs": {
    "courseStructure": "$design_course_structure",
    "style": { "language": "zh", "verbosity": "standard" }
  },
  "ctx": {
    "llm": "<宿主注入的 LLMProvider，可选>"
  }
}
```
