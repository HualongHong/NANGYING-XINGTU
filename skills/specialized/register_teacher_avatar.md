# 教师数字分身注册（register_teacher_avatar）

## 技能 ID
`register_teacher_avatar`

## 中文名
教师数字分身注册

## 类型
特化型（specialized）

## 输入
- `teacherProfile`：教师档案 `{ name, bio?, style?, appearancePreference? }`
- `avatarMaterials`：形象素材路径列表（可选）
- `voiceSamples`：声音样本路径列表（可选）

## 输入声明

> 机器可读契约（单一事实源）：`scripts/gen-registry.mjs` 据此生成 `manifests/skills.registry.json`，
> `scripts/validate.mjs` 校验 契约 ↔ 注册表 ↔ 执行器 三方一致。修改入参请改本段，不要手写注册表。

```yaml
usage: "注册教师数字分身（引擎未接入时降级为静态头像）"
inputs:
  - name: teacherProfile
    kind: object
    required: true
    hint: "教师档案 { name, bio?, style?, appearancePreference? }"
  - name: avatarMaterials
    kind: array
    required: false
    hint: "形象素材路径列表"
  - name: voiceSamples
    kind: array
    required: false
    hint: "声音样本路径列表"
```
## 输出
分身档案（降级形态）：
- `avatar`：`{ type: 'static', description, materials }`——静态头像占位描述（含姓名/风格/形象偏好，正式形象待数字人引擎接入后替换）
- `voice`：`{ type: 'none', note }`——未接入声音克隆，语音合成技能将退化为纯字幕
- `profile`：教师档案回显；`registeredMaterials`：登记的素材清单

## 依赖
- `digitalHumanModeling`：数字人建模引擎
- `voiceCloning`：声音克隆引擎

## 降级策略
数字人或声音克隆不可用时，退化为静态头像图片 + 文字讲稿。当前实现即此降级形态（level=degraded），产出可演示的分身档案中间态；宿主注入数字人 provider 后可升级为 full。

## 调用示例
```json
{
  "skillId": "register_teacher_avatar",
  "inputs": {
    "teacherProfile": { "name": "王老师", "style": "亲和严谨", "appearancePreference": "正装" },
    "avatarMaterials": ["photos/front.png"]
  }
}
```
