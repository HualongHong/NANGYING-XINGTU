/**
 * 囊萤星图插件自检脚本（纯 Node，无依赖）。
 * 校验：
 *   (a) plugin.manifest.json 中列出的 skillId 与 skills.registry.json 一一对应；
 *   (b) 注册表中每个 docPath 指向的 md 文件存在；
 *   (c) manifest 的 adapters 列表与 adapters/ 下目录一致；
 *   (d) 仓库卫生：git 跟踪文件不得包含 .env；.env.example 不得含真实形态 key；
 *   (e) 三方一致性：契约 md「输入声明」段 ↔ 注册表（gen-registry 生成）↔ executors 执行器
 *       （guarded 规格名/kind、IMPLEMENTED_SKILLS 清单），漂移即红；
 *   (f) skills.meta.json 与 manifest 的 skillId 一一对应（gen-registry 的元数据源）。
 * 任一失败 exit 1 并打印中文错误；全部通过则打印中文成功摘要。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { parseDeclaration } from './contract-decl.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'));
}

const manifest = readJson('manifests/plugin.manifest.json');
const registry = readJson('manifests/skills.registry.json');

// (a) skillId 一一对应
const manifestIds = [...manifest.skills.shared, ...manifest.skills.specialized];
const registryIds = registry.skills.map((s) => s.skillId);

const missingInRegistry = manifestIds.filter((id) => !registryIds.includes(id));
const missingInManifest = registryIds.filter((id) => !manifestIds.includes(id));
if (missingInRegistry.length > 0) {
  errors.push(`注册表缺少 manifest 声明的技能：${missingInRegistry.join('、')}`);
}
if (missingInManifest.length > 0) {
  errors.push(`manifest 缺少注册表声明的技能：${missingInManifest.join('、')}`);
}
if (manifestIds.length !== registryIds.length) {
  errors.push(`技能数量不一致：manifest ${manifestIds.length} 个，注册表 ${registryIds.length} 个`);
}

// (b) docPath 文件存在
for (const skill of registry.skills) {
  if (!skill.docPath || !existsSync(join(root, skill.docPath))) {
    errors.push(`技能 ${skill.skillId} 的文档不存在：${skill.docPath}`);
  }
}

// (c) adapters 目录一致（平台适配器 = 含 profile.json 的目录；core/odlab 等非平台子目录不参与）
const manifestAdapters = [...manifest.adapters].sort();
const dirAdapters = readdirSync(join(root, 'adapters'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, 'adapters', d.name, 'profile.json')))
  .map((d) => d.name)
  .sort();
const onlyInManifest = manifestAdapters.filter((a) => !dirAdapters.includes(a));
const onlyInDir = dirAdapters.filter((a) => !manifestAdapters.includes(a));
if (onlyInManifest.length > 0) {
  errors.push(`adapters/ 下缺少 manifest 声明的平台目录：${onlyInManifest.join('、')}`);
}
if (onlyInDir.length > 0) {
  errors.push(`manifest 未声明但 adapters/ 下存在的平台目录：${onlyInDir.join('、')}`);
}

// (d) 仓库卫生：git 跟踪文件不得包含 .env；.env.example 不得含真实形态 key
try {
  const tracked = execSync('git ls-files', { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  if (tracked.includes('.env') || tracked.includes('secrets.json')) {
    errors.push('仓库卫生：.env / secrets.json 被 git 跟踪（必须保持未跟踪）');
  }
} catch {
  // 无 git 环境（如分发包）跳过该检查
}
const examplePath = join(root, '.env.example');
if (existsSync(examplePath)) {
  const exampleLines = readFileSync(examplePath, 'utf8').split('\n');
  for (const line of exampleLines) {
    const t = line.trim();
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(t);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    // 允许空值或明显占位符；拒绝 20+ 位疑似真实 key
    if (value.length >= 20 && !/^(x|your|placeholder|fake)/i.test(value)) {
      errors.push(`仓库卫生：.env.example 的 ${m[1]} 疑似真实 key（值长 ${value.length}），请清空或改为占位符`);
    }
  }
}

// ---------- (e) 三方一致性：契约声明段 ↔ 注册表 ↔ 执行器 ----------

// (e0) 注册表必须带生成标记（防手写）
if (!registry.$generated || !String(registry.$generated).includes('gen-registry')) {
  errors.push('注册表缺少 gen-registry 生成标记：请运行 pnpm run gen:registry，禁止手写 manifests/skills.registry.json');
}

// (e1) 解析全部契约声明段，与注册表逐技能比对
const declById = new Map();
for (const skill of registry.skills) {
  const mdPath = join(root, skill.docPath);
  if (!existsSync(mdPath)) continue; // (b) 已报
  let decl;
  try {
    decl = parseDeclaration(readFileSync(mdPath, 'utf8'));
  } catch (err) {
    errors.push(`技能 ${skill.skillId} 的输入声明解析失败：${err.message}`);
    continue;
  }
  if (!decl) {
    errors.push(`技能 ${skill.skillId} 的契约文档缺少「## 输入声明」段：${skill.docPath}`);
    continue;
  }
  declById.set(skill.skillId, decl);

  const regInputs = JSON.stringify(skill.inputs ?? []);
  const declInputs = JSON.stringify(decl.inputs.map((i) => i.name));
  if (regInputs !== declInputs) {
    errors.push(`契约漂移（注册表↔契约）：${skill.skillId} 的 inputs 不一致：注册表 ${regInputs} vs 契约 ${declInputs}；请运行 pnpm run gen:registry`);
  }
  const regRequired = JSON.stringify(skill.required ?? []);
  const declRequired = JSON.stringify(decl.inputs.filter((i) => i.required).map((i) => i.name));
  if (regRequired !== declRequired) {
    errors.push(`契约漂移（注册表↔契约）：${skill.skillId} 的 required 不一致：注册表 ${regRequired} vs 契约 ${declRequired}`);
  }
  const regAliases = skill.aliases ?? {};
  const declAliases = {};
  for (const i of decl.inputs) for (const a of i.aliases) declAliases[a] = i.name;
  if (JSON.stringify(regAliases) !== JSON.stringify(declAliases)) {
    errors.push(`契约漂移（注册表↔契约）：${skill.skillId} 的 aliases 不一致：注册表 ${JSON.stringify(regAliases)} vs 契约 ${JSON.stringify(declAliases)}`);
  }
  const regKinds = JSON.stringify((skill.inputSpecs ?? []).map((s) => [s.name, s.kind]));
  const declKinds = JSON.stringify(decl.inputs.map((i) => [i.name, i.kind]));
  if (regKinds !== declKinds) {
    errors.push(`契约漂移（注册表↔契约）：${skill.skillId} 的 inputSpecs kind 不一致；请运行 pnpm run gen:registry`);
  }
  if ((skill.usage ?? '') !== (decl.usage ?? '')) {
    errors.push(`契约漂移（注册表↔契约）：${skill.skillId} 的 usage 不一致；请运行 pnpm run gen:registry`);
  }
}

// (e2) 执行器一致性：guarded 规格名必须是契约声明名；声明的必填入参必须有执行器校验
try {
  const src = readFileSync(join(root, 'adapters/core/executors.ts'), 'utf8');
  // 每个技能一处 guarded("<skill>", [ ... ], ...) / guarded('<skill>', [ ... ], ...)
  const guardedRe = /guarded\(\s*["']([a-z_]+)["']\s*,\s*\[([\s\S]*?)\]\s*,/g;
  const specNamesBySkill = new Map();
  let gm;
  while ((gm = guardedRe.exec(src)) !== null) {
    const [, skillId, body] = gm;
    const names = [];
    const specRe = /\{\s*name:\s*["']([^"']+)["']\s*,\s*kind:\s*["']([a-z]+)["']/g;
    let sm;
    while ((sm = specRe.exec(body)) !== null) names.push({ name: sm[1], kind: sm[2] });
    specNamesBySkill.set(skillId, names);
  }
  for (const skill of registry.skills) {
    const decl = declById.get(skill.skillId);
    if (!decl) continue;
    const declared = new Set(decl.inputs.map((i) => i.name));
    const declaredKind = new Map(decl.inputs.map((i) => [i.name, i.kind]));
    const specs = specNamesBySkill.get(skill.skillId);
    if (!specs) {
      errors.push(`执行器漂移：${skill.skillId} 在 executors.ts 中没有 guarded 规格`);
      continue;
    }
    for (const spec of specs) {
      const top = spec.name.split('.')[0];
      if (!declared.has(top)) {
        errors.push(`执行器漂移：${skill.skillId} 校验了契约未声明的入参 "${spec.name}"（契约声明：${[...declared].join('、')}）`);
      } else if (!spec.name.includes('.') && declaredKind.get(top) !== 'any' && spec.kind !== 'any' && declaredKind.get(top) !== spec.kind) {
        errors.push(`执行器漂移：${skill.skillId} 入参 "${top}" 的 kind 不一致：执行器 ${spec.kind} vs 契约 ${declaredKind.get(top)}`);
      }
    }
    for (const input of decl.inputs.filter((i) => i.required)) {
      if (!specs.some((s) => s.name.split('.')[0] === input.name)) {
        errors.push(`执行器漂移：${skill.skillId} 声明的必填入参 "${input.name}" 没有执行器校验（调用方按契约传参会漏检）`);
      }
    }
  }
  // IMPLEMENTED_SKILLS 与 manifest 技能清单一一对应
  const implMatch = /IMPLEMENTED_SKILLS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src);
  if (!implMatch) {
    errors.push('执行器漂移：executors.ts 中找不到 IMPLEMENTED_SKILLS 清单');
  } else {
    const implIds = [...implMatch[1].matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]);
    const missingImpl = manifestIds.filter((id) => !implIds.includes(id));
    const extraImpl = implIds.filter((id) => !manifestIds.includes(id));
    if (missingImpl.length > 0) errors.push(`执行器漂移：以下技能未接入执行器：${missingImpl.join('、')}`);
    if (extraImpl.length > 0) errors.push(`执行器漂移：executors 实现了 manifest 未声明的技能：${extraImpl.join('、')}`);
  }
} catch (err) {
  errors.push(`执行器一致性校验失败：${err.message}`);
}

// ---------- (f) skills.meta.json ↔ manifest ----------
try {
  const meta = readJson('manifests/skills.meta.json');
  const metaIds = Object.keys(meta.skills ?? {});
  const missingMeta = manifestIds.filter((id) => !metaIds.includes(id));
  const extraMeta = metaIds.filter((id) => !manifestIds.includes(id));
  if (missingMeta.length > 0) errors.push(`skills.meta.json 缺少 manifest 声明的技能：${missingMeta.join('、')}`);
  if (extraMeta.length > 0) errors.push(`skills.meta.json 多出 manifest 未声明的技能：${extraMeta.join('、')}`);
} catch (err) {
  errors.push(`skills.meta.json 读取失败：${err.message}`);
}

if (errors.length > 0) {
  console.error('校验失败：');
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log('校验通过，囊萤星图插件自检成功：');
console.log(`  - 技能清单一致：共 ${registryIds.length} 个技能（共享 ${manifest.skills.shared.length} 个，特化 ${manifest.skills.specialized.length} 个）`);
console.log('  - 仓库卫生：.env 未跟踪、.env.example 无真实 key');
console.log(`  - 技能文档齐备：${registry.skills.length} 个 docPath 全部存在`);
console.log(`  - 适配器目录一致：${dirAdapters.join('、')}`);
console.log('  - 三方一致：契约输入声明 ↔ 注册表（gen-registry 生成）↔ executors 别名/规格无漂移');
