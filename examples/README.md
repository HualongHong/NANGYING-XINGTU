# 示例文件（examples/）

本目录是一套**原创示例材料**，采用 [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/deed.zh) 公有领域声明：可自由复制、修改、商用，无需署名。全部内容由本仓库作者撰写，人物、单位、会议均为虚构，与任何真实文献无关。

> 历史沿革：早期开发曾使用真实教材/摘要集做本地验证（272MB），因版权问题**不入库**，已移至本地 `dev-docs/testfiles/`（gitignored）。本目录替代其示例角色，供任何拿到仓库的人直接演练插件。

| 文件 | 演练技能 | 说明 |
|---|---|---|
| `讲义-光合作用基础.md` | `parse_course_material` → `extract_knowledge_graph` → `design_course_structure` → `generate_teaching_script`（配方 1 前半） | 原创讲义：三节结构、概念定义、小结，含知识图谱友好标题层级 |
| `摘要集-青年生态学论坛.txt` | `parse_abstract_collection` → `select_research_evidence` → `compose_teaching_artifacts` → `audit_teaching_package`（配方 5 全链） | 虚构会议摘要集：`\f` 分页、封面无页码（Δ=1 偏移探测演示）、两个分会场标题、`0001` 式条目编号行（`entryPattern: "^\\d{4}\\s"`）、题名/作者/单位+邮编/关键词/正文版式 |
| `章节知识点-生态系统生态学.json` | `select_research_evidence` 的 `sections` 入参 | 章节知识结构：节名+知识点+重点+易混概念（排除词），与摘要集内容呼应 |

快速演练（配方 5）：

```bash
# 分页文本由 pdftotext 直出时最完整；示例文件已内置 \f 分页，可直接整读
```

```json
{ "skillId": "parse_abstract_collection", "inputs": { "materialFile": "examples/摘要集-青年生态学论坛.txt", "entryPattern": "^\\d{4}\\s", "declaredTotal": 7 } }
```

自动化守卫：`tests/examplesWalkthrough.test.ts` 对本目录材料跑配方 5 五技能全链（需求治理→解析→选文→组装→验收）。修改示例材料后运行 `npx vitest run tests/examplesWalkthrough.test.ts` 核对仍可通过。
