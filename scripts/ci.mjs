/**
 * CI 串行脚本：validate → typecheck → test，任一失败 exit 1。
 */
import { spawnSync } from 'node:child_process';

// Windows 下 pnpm 是 .cmd shim，spawnSync 需要 shell 才能解析；
// 命令为内部固定字符串，无注入风险
const steps = [
  ['校验契约', 'node scripts/validate.mjs'],
  ['类型检查', 'pnpm typecheck'],
  ['单元与集成测试', 'pnpm test'],
];

for (const [name, command] of steps) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(command, { stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`\nCI 失败：${name} 未通过`);
    process.exit(1);
  }
}

console.log('\nCI 全部通过：校验 ✓ 类型检查 ✓ 测试 ✓');
