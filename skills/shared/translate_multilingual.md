# 多语种翻译（translate_multilingual）

## 技能 ID
`translate_multilingual`

## 中文名
多语种翻译

## 类型
共享型（shared）

## 输入
- `script`：教学脚本全稿（generate_teaching_script 的 TeachingScript，逐 scene 翻译 voiceover/subtitle）；或 `paragraphs`：纯文本段落列表（`string[]`）。二选一。
- `targetLanguages`：目标语种列表（结构预留 zh/en/ru/fr/ko 等）
- `glossary`（可选）：术语库（Glossary 对象或其 JSON 字符串），导入格式见 `core/i18n/glossary.ts`
- `ctx`（可选）：宿主注入上下文，可携带 `llm`（`LLMProvider`）启用逐段翻译

说明：契约原文输入为 `chineseScript`（中文讲稿文本），实现侧明确为上述两种结构化输入之一，讲稿文本走 `paragraphs` 形态。

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "把教学脚本或段落翻译成多语种文本并保持术语一致"
inputs:
  - name: script
    kind: object
    required: false
    aliases: ["chineseScript"]
    hint: "generate_teaching_script 的 TeachingScript（与 paragraphs 二选一）"
    producer: ["generate_teaching_script"]
  - name: paragraphs
    kind: array
    required: false
    hint: "纯文本段落列表 string[]（与 script 二选一；讲稿文本走这里）"
  - name: targetLanguages
    kind: array
    required: true
    hint: "目标语种列表，如 ["zh","en","ru","fr","ko"]"
  - name: glossary
    kind: any
    required: false
    hint: "术语库（Glossary 对象或其 JSON 字符串）"
  - name: async
    kind: boolean
    required: false
    hint: "true 时提交异步作业、毫秒级返回 jobId，用 manage_async_tasks 轮询（不受宿主超时限制；LLM 阶段无同步预算上限）"
  - name: progress
    kind: boolean
    required: false
    hint: "true 请求进度回报：异步作业进度写快照；MCP 通道经 progress 通知推送"
```
## 输出
- `multilingualTexts`：各语种一份同构产物——scene 的 voiceover/subtitle 为该语种译文，结构字段（id、lessonId、时长、起始分钟、知识点 ID 等）原样保留不动；段落输入则返回译文数组
- `termGlossary`：实际参与翻译的术语对照表
- `termReport`：术语使用报告（逐语种、逐片段）：哪些术语被词表强制替换（`replaced`）、哪些已是规范译法（`kept`）

## 依赖
- `mtEngine`：机器翻译引擎（即注入的 `llm`；可选，缺省时走降级路径）
- `terminologyBase`：课程术语库（可选；提供时强制术语一致）

## 降级策略
- **无翻译引擎（未注入 llm）或 LLM 调用失败时**：退化为**术语标注稿**——正文保留原文，词表命中的术语在其后附目标语规范译法标注（如"梯度下降（gradient descent）"），level 标记 degraded。此为契约原文"仅中英"降级语义的实现侧约定：标注稿对任意目标语种均可产出，且术语译文严格来自词表。
- 目标语种列表为空或输入文本为空时，仅返回空产物并标记 degraded。

## 术语一致性
LLM 译文经词表强制校正：译文中命中的术语（规范化比较，大小写/全半角不敏感）统一替换为目标语规范译法——包括 LLM 漏译残留的源语术语（如英文稿中残留"梯度下降"会被替换为 "gradient descent"）；已是规范译法（含大小写变体）的不改动。全部命中记录进入 `termReport`。

## 调用示例
```json
{
  "skillId": "translate_multilingual",
  "inputs": {
    "script": "$generate_teaching_script",
    "targetLanguages": ["zh", "en", "ru", "fr", "ko"],
    "glossary": "<术语库 Glossary 对象或 JSON 字符串，可选>"
  },
  "ctx": {
    "llm": "<宿主注入的 LLMProvider，可选>"
  }
}
```
