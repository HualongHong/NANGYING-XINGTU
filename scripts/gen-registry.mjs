/**
 * 注册表生成器：契约 md「输入声明」段（单一事实源）+ 描述元数据（manifests/skills.meta.json）
 * → manifests/skills.registry.json。
 *
 * 生成内容：inputs（契约真名，有序）/ required / inputSpecs（name/kind/required/aliases/hint/producer）
 * / aliases（别名→真名，扁平化）/ usage。registry 头部带 $generated 标记，validate 拒绝手写漂移。
 *
 * 用法：node scripts/gen-registry.mjs（或 pnpm run gen:registry）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeclaration } from './contract-decl.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const manifest = readJson('manifests/plugin.manifest.json');
const meta = readJson('manifests/skills.meta.json');

const manifestIds = [...manifest.skills.shared, ...manifest.skills.specialized];
const metaIds = Object.keys(meta.skills);

// 元数据 ↔ manifest 对齐
for (const id of manifestIds) {
  if (!meta.skills[id]) errors.push(`skills.meta.json 缺少 manifest 声明的技能：${id}`);
}
for (const id of metaIds) {
  if (!manifestIds.includes(id)) errors.push(`skills.meta.json 多出 manifest 未声明的技能：${id}`);
}

// 解析全部契约声明
const declById = new Map();
for (const id of manifestIds) {
  if (!meta.skills[id]) {
    errors.push(`skills.meta.json 缺少 manifest 声明的技能：${id}`);
    declById.set(id, null);
    continue;
  }
  const m = meta.skills[id];
  const mdPath = join(root, m.docPath);
  let decl;
  try {
    decl = parseDeclaration(readFileSync(mdPath, 'utf8'));
  } catch (err) {
    errors.push(`技能 ${id} 的输入声明解析失败：${err.message}`);
    continue;
  }
  if (!decl) {
    errors.push(`技能 ${id} 的契约文档缺少「## 输入声明」段：${m.docPath}`);
    continue;
  }
  const names = new Set();
  for (const input of decl.inputs) {
    if (names.has(input.name)) errors.push(`技能 ${id} 声明了重复入参：${input.name}`);
    names.add(input.name);
  }
  for (const input of decl.inputs) {
    for (const alias of input.aliases) {
      if (names.has(alias)) errors.push(`技能 ${id} 的别名 "${alias}" 与契约真名重复`);
    }
    for (const p of input.producer ?? []) {
      if (!manifestIds.includes(p)) errors.push(`技能 ${id} 入参 ${input.name} 的 producer "${p}" 不是已声明技能`);
    }
  }
  declById.set(id, decl);
}

if (errors.length > 0) {
  console.error('注册表生成失败：');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

// 生成（顺序 = manifest 声明顺序）
const skills = manifestIds.map((id) => {
  const m = meta.skills[id];
  const decl = declById.get(id);
  const inputSpecs = decl.inputs.map((i) => {
    const spec = { name: i.name, kind: i.kind, required: i.required };
    if (i.aliases.length > 0) spec.aliases = i.aliases;
    if (i.hint) spec.hint = i.hint;
    if (i.producer && i.producer.length > 0) spec.producer = i.producer;
    return spec;
  });
  const aliases = {};
  for (const i of decl.inputs) {
    for (const a of i.aliases) aliases[a] = i.name;
  }
  const entry = {
    skillId: id,
    name: m.name,
    type: m.type,
    description: m.description,
    inputs: decl.inputs.map((i) => i.name),
    required: decl.inputs.filter((i) => i.required).map((i) => i.name),
    inputSpecs,
    outputs: m.outputs,
    dependsOn: m.dependsOn,
    degradation: m.degradation,
    docPath: m.docPath,
  };
  if (Object.keys(aliases).length > 0) entry.aliases = aliases;
  if (decl.usage) entry.usage = decl.usage;
  return entry;
});

const registry = {
  $schema: 'nangying-starmap/skills-registry@1.2.0',
  $generated: '本文件由 scripts/gen-registry.mjs 生成，禁止手写；契约声明源 skills/**.md 的「输入声明」段，描述元数据源 manifests/skills.meta.json。改动入参请改契约声明段后重新生成。',
  skills,
};

writeFileSync(
  join(root, 'manifests/skills.registry.json'),
  JSON.stringify(registry, null, 2) + '\n',
);
console.log(`已生成 manifests/skills.registry.json：${skills.length} 个技能（共享 ${manifest.skills.shared.length}，特化 ${manifest.skills.specialized.length}）`);
