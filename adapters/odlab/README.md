# OpenDataLab 体系平台对接层

上海 AI Lab / OpenDataLab 体系平台的统一适配。一家平台一个文件，统一签名：`keyProvider` 惰性取钥 + `fetchImpl`/SDK 可注入 + 错误脱敏 + 超时。密钥只从 `secrets.json`（命名密钥）或 `.env` 调试通道读取，永不入库/入日志。

| 平台 | 文件 | 能力 | 接入方式 | 档位 |
|---|---|---|---|---|
| MinerU (mineru.net) | `mineru.ts` | 高精度文档解析（表格→HTML、公式→LaTeX、扫描件 OCR） | 免费档免 Token（`/api/v1/agent/parse/file`，≤10MB/20 页，仅 Markdown，IP 限频）；精准档 Bearer Token（`/api/v4/extract/task` 异步→轮询→zip，≤200MB；每日免费高优额度以官网为准） | **Tier 1 已实装**：`provider="mineru"` 进 `parse_course_material` 解码阶梯（配置位③）；平台失败自动回落本地链路 |
| SciVerse (sciverse.space) | `sciverse.ts` | Sci-Base 学术基座：4.66 亿+ 元数据、2826 万全文证据段 | Console > Tokens 创建 key（起步额度免费）；官方 `sciverse` npm SDK（optionalDependencies + pnpm 补丁修复其 ESM 扩展名） | **Tier 1 已实装**：技能 `enrich_knowledge_evidence`（第 25 个共享技能）；无 key/失败 → degraded，图谱不动 |
| DianShi 点石 | —（预留） | Sci-Align 层：化学反应检索与逆合成 RAG（生命/化学跨模态对齐） | 同一 console key 体系，**按账号权限申请接入** | **Tier 2 预留**：接入点=复用 `sciverse.ts` 同型工厂（`createSciverseService` 加 `service:'dianshi'` 方法映射）；化学生物课程增强位，待平台授权后实装 |
| OpenDataLab 数据集 (opendatalab.com) | —（预留） | 数据集中心：公开数据集检索/下载（AK/SK + openxlab CLI） | 账号 AK/SK | **Tier 3 预留**：教学素材数据集发现，价值评估后再定 |
| Sci-Evo（科学演进推理） | —（观察） | 官方标注 coming soon | — | 仅文档观察位 |

## SciVerse SDK 扩展位（已映射/待开放）

已映射：`semanticSearch`（契约 mode=agentic，含 fast/balanced/quality）与 `searchMetadata`（mode=meta）。
待开放（按需求实装）：`readContent`（按 doc_id+offset 取正文切片，extend RAG 上下文）、`getResource`（图表二进制，多模态 RAG）、`listPaperRelations`（引用/被引/相关文献图谱）。

## 独立性保证

- MinerU：仅在用户显式配置 `provider="mineru"` 后进入解码链；任何失败由 `parse_course_material` 既有阶梯（原生文本→本地 OCR→宿主注入→kimi/openai→尽力文本）兜底。
- SciVerse：`enrich_knowledge_evidence` 为可选挂接技能；平台不可用返回 `degraded` + 原图谱，主流程不中断。
