/**
 * CI/本地通用：跑测试并在失败时把关键行回注为 GitHub 注解（跨平台，替代
 * bash 的 tee + PIPESTATUS + grep 组合——Windows runner 默认 pwsh 无这些）。
 * 测试通过后接反馈闭环监控（feedback-loop）。
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync('pnpm test', {
  shell: true,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(out);

if (result.status !== 0) {
  const lines = out.split('\n')
    .filter((l) => /FAIL|×|Failed Tests|Tests {2}|Error/.test(l))
    .slice(0, 25);
  for (const l of lines) console.log(`::error::${l}`);
  console.error('\n测试未通过');
  process.exit(result.status ?? 1);
}

const loop = spawnSync('node scripts/feedback-loop.mjs', { stdio: 'inherit', shell: true });
process.exit(loop.status ?? 0);
