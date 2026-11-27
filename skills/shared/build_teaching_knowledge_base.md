# 教学知识库构建（build_teaching_knowledge_base）

## 技能 ID
`build_teaching_knowledge_base`

## 中文名
教学知识库构建

## 类型
共享型（shared）

## 输入
- `materials`：材料数组 `[{ materialId, parse, origin?, citation? }]`——`parse` 为 parse_course_material 完整输出；`origin` 证据来源类型（默认 `corpus`；摘要集导入用 `abstractCollection`）；`citation` 引用信息 `{ url?, doi?, venue?, year?, retrievedAt?, license? }`（开放材料必填位，缺失字段=未提供，绝不补造）。
- `graph`：课程知识图谱（extract_knowledge_graph / fuse_knowledge_graphs 完整输出；实体 source/confidence 用于证据挂接与置信度承袭）。
- `assessments`（可选）：题目数组 `[{ id, question, options? }]`——wordfamily 回挂概念关联。
- `qaPairs`（可选）：问答数组 `[{ id, question, answer }]`——同上。
- `kbId`（可选）：知识库标识（缺省按材料内容哈希派生，同材料同 kbId）。
- `persist`（可选，默认 true）：是否落盘 `.nangying-starmap/kb/<kbId>/kb.json`（false 仅返回内存结果）。
- `async`（可选）：true 提交异步作业，`manage_async_tasks` 轮询（大语料构建不受宿主单次调用超时限制）。

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "教学知识库构建（KAG-1）：材料+图谱 → 概念分层/段落级证据/关联/索引一体的持久化 KB，六环节（教案/课件/讲稿/测试/辅导/出卷）统一取材面；含 coverageGaps 缺口清单"
inputs:
  - name: materials
    kind: array
    required: true
    hint: '材料数组 [{ materialId, parse, origin?, citation? }]；parse 为 parse_course_material 完整输出'
    producer: [parse_course_material]
  - name: graph
    kind: object
    required: true
    hint: '课程知识图谱（extract/fuse 完整输出，含 entities/relations）'
    producer: [extract_knowledge_graph, fuse_knowledge_graphs]
  - name: assessments
    kind: array
    required: false
    hint: '题目数组 [{ id, question, options? }]，wordfamily 回挂概念'
    producer: [generate_assessment]
  - name: qaPairs
    kind: array
    required: false
    hint: '问答数组 [{ id, question, answer }]，wordfamily 回挂概念'
    producer: [build_qa_knowledge_base]
  - name: kbId
    kind: string
    required: false
    hint: '知识库标识（缺省按材料内容哈希派生）'
  - name: persist
    kind: boolean
    required: false
    hint: '是否落盘 .nangying-starmap/kb/<kbId>/kb.json（默认 true）'
  - name: async
    kind: boolean
    required: false
    hint: 'true 提交异步作业（大语料），manage_async_tasks 轮询'
```

## 输出
- `knowledgeBase`：KB artifact（schema `nangying-starmap/kb@1`）——concepts（origin 分层：本层恒 corpus，external/inferred 经采集回路进入）/ evidence（段落级证据块，chunking 复用 parse 段落寻址）/ links（conceptToEvidence ∪ 标签包含匹配、evidenceToEvidence 共享概念限额、itemToConcept wordfamily）/ indexes（倒排 + 概念邻接表 + vector=null 预留位）/ stats（含 coverageGaps 无证据概念清单）。
- `persisted`：落盘路径（persist=true 时）。
- 校验违规如实上报（schema 驱动校验，违规即 degraded 不静默）。

## 依赖
纯本地确定性实现，零密钥零平台依赖；大语料建议 `async: true`。

## 降级策略
输入非 materials+graph 完整形态 → 返回空 KB 骨架（degraded + 下一步引导），不抛异常；条目挂接为 wordfamily 确定性命中，未命中如实不挂（不凑数）；LLM 提议挂接与外部证据采集为 R25 采集回路位，本技能不虚构任何证据与引用。

## 调用示例
```json
{
  "skillId": "build_teaching_knowledge_base",
  "inputs": {
    "materials": [{ "materialId": "lecture-01", "parse": "$parse_course_material" }],
    "graph": "$extract_knowledge_graph",
    "qaPairs": "$build_qa_knowledge_base.qaPairs"
  }
}
```
