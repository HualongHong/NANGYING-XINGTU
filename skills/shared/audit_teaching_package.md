# 教学包验收（audit_teaching_package）

## 技能 ID
`audit_teaching_package`

## 中文名
教学包验收

## 类型
共享型（shared）

## 输入
- `artifacts`（必填）：四件套产物文本 `{ slides?, reading?, html?, lessonPlan? }`——每项为字符串、`{ text }` 或（reading 专有）`{ pages: string[] }`（pdftotext 分页文本，用于配对校验）
- `expectedNumbering`（可选）：期望编号数组（`compose_teaching_artifacts` 的 `numberingMap.caseNo` 直接传入）——跨产物覆盖/多余/顺序比对
- `options.extraForbiddenWords`（可选）：追加禁用词
- `options.pairHints`（可选）：配对提示词覆盖 `{ original?, commentary? }`（默认：原文/节选/照录 ↔ 解读/解说/评析）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "四件套交付前验收：C1–C8 验收链——零外链/禁用词/占位符/编号一致/来源口径/配对（纯检查）+ 编译写盘打印同步（delegated 程序指引）+ 红线触发清单"
inputs:
  - name: artifacts
    kind: object
    required: true
    hint: "{ slides?, reading?, html?, lessonPlan? }：字符串、{ text } 或 reading 的 { pages: string[] }（分页文本）"
  - name: expectedNumbering
    kind: array
    required: false
    hint: "期望编号数组（compose_teaching_artifacts 的 numberingMap.caseNo）：跨产物覆盖/多余/顺序比对"
    producer: ["compose_teaching_artifacts"]
  - name: options
    kind: object
    required: false
    hint: "{ extraForbiddenWords?: string[], pairHints?: { original?, commentary? } }"
```

## 输出
- `report`：逐项判据 `[{ id, name, verdict: 'pass'|'fail'|'delegated', evidence }]`——evidence 带命中行号/计数/差集，不靠目测
- `redlineTriggers`：红线触发清单 `[{ redline, signal, action }]`（方法论 M 章）——触发任一红线，**停下来向用户确认**，不自行决定
- `passed`：非 delegated 判项全部 pass（全 delegated 为 false：未验证不等于通过）

本技能执行的纯检查（deterministic）：
- `C6-zero-external` 零外链（学生 HTML）：`https?://`、`<link>`、`<script src>`、`@import`、`@font-face`、`cdn.`、`fetch(`、`XMLHttpRequest/WebSocket`、`srcset`、`url(...)`（豁免内联 SVG `url(#id)` 与 `data:`）
- `C7-forbidden-words` 学生可见禁用词（7.2：课程设计/课时组织/制作信息/教师专属/归属残留）：命中数必须为 0；教案与交付说明属教师文档**不受此表约束**
- `C3-placeholders` 未定稿占位符：待补/占位/草稿/TODO/FIXME/lorem 零命中（H7 不半成品交付）
- `C5-numbering` 编号覆盖与顺序：各产物抽出「选读/案例/阅读编号 NN」集合与 `expectedNumbering` 比对——缺/多/顺序乱即 fail（F3：差值必须能解释）
- `C6-source-fields` 来源字段口径：每行须有 DOI 或「未提供」，题名与作者不得双双缺失（H2 不补造）
- `L2-pairing` 原文/解读配对：奇数页原文、偶数页解读（分页首行提示词校验），末页无配对即 fail

 delegated 判项（宿主环境重操作，本模块给程序指引）：
- `C1-compile-log` 两遍 xelatex 后错误/溢出/缺字=0；告警先归因再接受（M8：模板随页数线性增长属正常）
- `C2-pdf-written` 核对时间戳/页数/大小（F08：阅读器占用致日志正常但旧文件仍在）
- `C4-html-print` --print-to-pdf 实际生成后查「答案展开行数>0、控件文案行数=0」（E4：dump-dom 双引号假阴性）
- `C8-final-sync` 同名与定稿逐字节一致、无残留进程（F09：覆盖确认弹窗挂起无人值守任务）

## Agent 执行协议（技能正文）
1. **验证阶梯**（N1）：grep/正则 → node --check → 两遍编译 → bbox 全页扫描 → headless 浏览器 → 渲染 PNG 目视，**前一步不过不进下一步**；编译是重操作，一次改动只跑一轮两遍编译并显式给足超时（N2）。
2. **可并行组**（N3）：关键页渲染、全页 bbox、打印预览、隔离目录回滚编译、结构计数 diff 同批发起；改 tex→编译→bbox→目视必须串行（目视用最新 PDF）。
3. **bbox 定量**（D1）：`pdftotext -bbox` 取词坐标，「最低正文 yMax vs 页脚 yMin」间隔须 >0 且 ≥5pt 安全线，全页 x≤595.28pt、y≤841.89pt（A4）。
4. **目视抽查**（5.3/5.4，建议项）：最密页/本版新增页/图表页/打印版关键页各抽一页；`零错误/零溢出/零缺字` 只说明排版引擎没报错，不代表可投影（F05）。
5. **回滚实测**（G3）：隔离临时目录用备份+依赖跑两遍编译核对复原基线——只查「备份齐不齐」不算回滚验证。
6. **收手条件**（N8）：指标全绿+关键页目视通过即停，不为「再好看一点」无限迭代。
7. **反馈联动**：验收 fail 项与红线触发经 `submit_feedback`（usage_issue/suggestion）入库，供 loop engineering 监控。

## 依赖
无（纯文本检查，零 IO、零 LLM、零外部平台）。

## 降级策略
- 产物文本未提供（如只做了编译）：对应判项 `delegated`，passed 只统计已执行判项——未验证不冒充通过。
- 输入非法（artifacts 缺失）返回结构化错误。

## 调用示例
```json
{
  "skillId": "audit_teaching_package",
  "inputs": {
    "artifacts": {
      "slides": { "text": "……选读 01……选读 02……" },
      "reading": { "pages": ["原文 群落稳定性……", "解读 这一篇在问……"] },
      "html": "<!DOCTYPE html><html lang=\"zh-CN\">……"
    },
    "expectedNumbering": ["01", "02"]
  }
}
```
