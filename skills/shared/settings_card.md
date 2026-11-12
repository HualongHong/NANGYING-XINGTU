# 设置卡片（settings_card）

## 技能 ID
`settings_card`

## 中文名
设置卡片

## 类型
共享型（shared）

## 输入
- `stage`（可选）：`render`（默认）按平台政策渲染设置卡片；`apply` 校验并应用设置；`status` 脱敏回显当前配置
- `platform`（可选）：平台标识 `dsh` | `kimi` | `trae` | `codex` | `workbuddy` | `qoder` | `local`；缺省取执行上下文注入的宿主平台，再缺省按 `generic` 保守政策对待（端口不开放）
- `settings`（apply 必填）：设置对象——`provider`（`local-ocr` | `kimi` | `openai` | `mineru`，与 `sciverseApiKey` 至少其一）、`model?`、`endpoint?`（仅 http(s) URL）、`apiKey?`（缺省不动，空字符串=清除）、`port?`（1-65535，仅 `http-capable` 平台如 local 可设）、`sciverseApiKey?`（SciVerse 学术证据 Token，可单独设置，空字符串=清除）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "三阶段设置卡片：stage=render（默认）按平台政策渲染设置卡片（解码器 API key 与连接端口字段，供宿主渲染 UI）；apply 校验并写入 settings.json（644）/secrets.json（0600，密钥永不回显）；status 脱敏回显当前配置（密钥只报后 4 位指纹）"
inputs:
  - name: stage
    kind: string
    required: false
    hint: '"render"（默认）渲染卡片 | "apply" 应用设置 | "status" 查看当前配置'
  - name: platform
    kind: string
    required: false
    hint: "平台标识 dsh|kimi|trae|codex|workbuddy|qoder|local；缺省取执行上下文平台，再缺省 generic 保守政策"
  - name: settings
    kind: object
    required: false
    hint: "apply 必填：{ provider(与 sciverseApiKey 至少其一), model?, endpoint?, apiKey?(空串=清除), port?(仅 http-capable 平台), sciverseApiKey?(学术证据 Token，可单独设置) }"
```

## 输出
- render 返回 `card`（声明式卡片：sections/fields/kind/required/default/policy/secret 标记 + `policyNotes` 平台政策要点）+ `next` 引导；字段 `secret: true`（apiKey）要求宿主用密码输入框渲染且不落日志
- apply 返回 `applied`（变更清单）+ `secret`（stored/fingerprint，只含后 4 位指纹）+ `port` + 配置文件路径；settings.json 存非敏感配置，密钥单独写 secrets.json（0600）
- status 返回当前 `provider/model/endpoint/port` + `apiKey: { configured, fingerprint? }`（只报后 4 位）+ 平台政策说明

## 依赖
- 无（纯本地配置读写；平台政策为 core/config/settingsCard.ts 静态矩阵，源自各平台 profile.json 事实）

## 平台政策（卡片随平台适配）
- **六 agent 平台（dsh/kimi/trae/codex/workbuddy/qoder）**：均经 MCP stdio 接入 → 端口区块隐藏（`visible: false` + hiddenReason）；宿主注入 LLM（profile llm.value=true）→ apiKey 可留空，仅视觉 OCR 后端需要
- **local（自托管）**：HTTP JSON-RPC 可用 → 端口区块可见（默认 7379，仅绑 127.0.0.1）；LLM 回退 .env/secrets
- **generic（未识别）**：保守政策——密钥 600 存储不回显，端口不开放
- **全平台硬约束**：密钥任何阶段不回显明文（status 只报后 4 位指纹）；secrets.json 0600；端口仅 127.0.0.1

## 降级策略
无外部依赖，永远可用。输入非法返回 `INVALID_INPUT` 结构化错误（含期望形态与最小示例）；`apply` 在 stdio 平台收到 `port`、provider 非法、endpoint 非 http(s) URL、port 越界时一律拒绝写入；密钥字段永不进入任何输出/日志。

## 调用示例
```json
{
  "skillId": "settings_card",
  "inputs": { "stage": "render", "platform": "kimi" }
}
```
用户填完卡片后：
```json
{
  "skillId": "settings_card",
  "inputs": {
    "stage": "apply",
    "platform": "kimi",
    "settings": { "provider": "openai", "model": "gpt-4o", "apiKey": "sk-用户输入" }
  }
}
```
查看配置：
```json
{ "skillId": "settings_card", "inputs": { "stage": "status" } }
```
