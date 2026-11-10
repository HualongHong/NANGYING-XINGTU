# Loop Engineering（反馈驱动的自我革新机制）

> 闭环：**捕获 → 脱敏 → 审阅门 → 入库 → 指标监控 → 开发门槛 → 迭代**。
> 本文件定义"编程端"的 loop engineering：基于**已接受**的回馈信息设定后期开发门槛与自我监控指标。

## 1. 回馈捕获与审阅门（submit_feedback）

- 技能 `submit_feedback`（共享型）是唯一入口，两阶段：
  - `stage=prepare`：编排反馈草稿，**默认脱敏全部敏感形态**（API key/令牌/邮箱/IP/用户路径/.env 赋值/长随机串，规则见 `core/feedback/sanitize.ts`），返回草稿与脱敏清单——**绝不落盘**；
  - 用户审阅草稿；`stage=approve` 且 `approved=true` 才入库至 `.nangying-feedback/`（gitignored），否则拒绝储存。
- **显式敏感通道**：用户明确命令 `includeSensitive=true` 并提供 `sensitiveExcerpt` 时，片段以「敏感附件」段原样入库（醒目标记"请勿外传"），用于调试；未开启该开关的片段一律忽略。
- 反馈类型 `kind`：`install_issue`（安装问题）/ `usage_issue`（使用问题）/ `praise`（满意执行）/ `not_used`（未使用插件的场景）/ `suggestion`（改进建议）。

## 2. 自我监控指标（feedback-loop.mjs）

`node scripts/feedback-loop.mjs`（CI 已接入 `scripts/ci.mjs`）从 `index.jsonl` 计算：

| 指标 | 含义 | 数据源 |
|---|---|---|
| `total` / `consumed` | 已接受反馈总数 / 已消化数 | index.jsonl |
| `byKind` | 五类反馈分布 | index.jsonl |
| `sensitiveCount` / `sensitiveRatio` | 敏感附件条数与占比（审阅纪律） | index.jsonl |
| `unconsumedIssues` | 未消化问题数（install/usage 未标记 consumed） | index.jsonl |
| `oldestUnconsumedAgeDays` | 最老未消化问题滞留天数 | index.jsonl |

阈值集中管理于 `manifests/loop.thresholds.json`：`minFeedbackBeforeGating`（样本量激活线，低于则门槛不触发——CI 无反馈库时安全通过）、`maxUnconsumedIssues`、`maxSensitiveAttachedRatio`、`stalenessWarnDays`。

## 3. 开发门槛（硬强制）

1. **CI 门槛**：`feedback-loop.mjs` 在样本量达标后，任一指标超阈 → exit 1，`pnpm run ci` 失败——**先闭环反馈，再做新开发**。
2. **迭代准入清单**（每个 R 迭代 commit 前自查）：
   - 契约先行：改入参只改 `skills/**.md` 的「输入声明」段 → `pnpm run gen:registry` → `pnpm run validate` 三方一致；
   - 全量测试绿 + `adapterProfile` 三方一致用例（manifest↔目录↔测试）不漂移；
   - CHANGELOG 记录行为变更；pre-commit 护栏通过（无 .env/扫描件/密钥形态）。
3. **反馈复现要求**：新 issue 类反馈（install/usage）必须附 `submit_feedback` prepare 草稿（含环境与复现步骤）；无法复现的问题先标记 `consumed` 并注明原因，不得长期滞留。
4. **praise 转回归**：`praise`/`not_used` 类满意执行，提炼为回归测试金标或文档案例（"满意"的路径要被测试锁定，"未用插件"的路径要回答为什么并转化为改进项）。

## 4. 消化与再生意图

- 维护者将反馈转为 backlog/修复后：`node scripts/feedback-loop.mjs --consume <docId>` 标记已消化，退出未消化计数。
- 每次发布前：指标全绿 + `unconsumedIssues=0`（或全部显式放弃）；`sensitiveRatio` 持续偏高说明调试通道被滥用，应改为本地复现而非收集敏感信息。
- 门槛本身可演进：`loop.thresholds.json` 的修改须随 CHANGELOG 说明理由（机制自监控的元规则）。
