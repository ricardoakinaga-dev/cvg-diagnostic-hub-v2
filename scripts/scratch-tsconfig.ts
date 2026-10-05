import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * `next dev` and `next build` with a custom distDir append "<distDir>/types/**" to the tsconfig they load,
 * so every Playwright or benchmark run used to leave dozens of stale entries in the committed tsconfig.json.
 * Disposable servers load this throw-away file instead (typescript.tsconfigPath in next.config.mjs); it only
 * extends the real configuration, lives under a gitignored directory and is the only file Next may rewrite.
 */
export const SCRATCH_TSCONFIG = ".next-scratch/tsconfig.json";

export function ensureScratchTsconfig(root: string = process.cwd()): string {
  const target = path.join(root, SCRATCH_TSCONFIG);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ extends: "../tsconfig.json" }, null, 2) + "\n");
  return SCRATCH_TSCONFIG;
}
