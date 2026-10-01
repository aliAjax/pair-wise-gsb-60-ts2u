// 合并语义测试运行器：用 esbuild 打包 scripts/test-merge.ts（注入 $app/environment 垫片），
// 再以子进程执行，结束后清理临时文件。
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shim = join(root, 'node_modules', '.cache-merge-test-shim.mjs');
const outfile = join(root, 'node_modules', '.cache-merge-test.mjs');

writeFileSync(shim, 'export const browser = true;\nexport const dev = false;\n');

try {
  await build({
    entryPoints: [join(root, 'scripts', 'test-merge.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    alias: { '$app/environment': shim },
    logLevel: 'warning'
  });

  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  for (const file of [shim, outfile]) {
    if (existsSync(file)) rmSync(file);
  }
}
