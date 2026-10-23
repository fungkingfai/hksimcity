/**
 * Cloudflare Workers Builds 相容：Builds 預設只執行 `npx wrangler deploy`，
 * 冇獨立 build command，所以用 npm `postinstall` 在 `npm ci` 之後自動建置 dist。
 *
 * - 正常環境（有 devDependencies）→ `npm run build` 生成最新 dist；
 * - 若 CI 以 production-only 安裝（冇 vite／typescript）→ 沿用 repo 內已 commit 的 dist；
 * - 兩者都冇 dist → 讓安裝失敗（避免部署空白 Worker）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const hasDist = existsSync('dist/index.html');
const result = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

if (result.status === 0) {
  console.log('[ci-build] dist 建置完成');
} else {
  console.warn(
    '[ci-build] npm run build 失敗（可能 CI 只安裝 production dependencies）；' +
      (hasDist ? '沿用 repo 內已建置的 dist/' : '而且沒有 fallback dist，部署終止'),
  );
  if (!hasDist) process.exit(result.status ?? 1);
}
