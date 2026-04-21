/**
 * ash build — package for distribution.
 *
 * ash depends on Hyperswarm/Hypercore which use NAPI native binaries (.node
 * files). These cannot be bundled into a single self-contained executable by
 * tools like pkg, nexe, or Node SEA.
 *
 * Distribution strategy:
 *   npm run build              → creates ash-<version>.tgz
 *   npm install -g ash-*.tgz  → installs globally, adds 'ash' to PATH
 *
 * Or install directly from source:
 *   npm install && npm install -g .
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { version: string };
console.log(`\nash v${pkg.version} — building tarball…\n`);

const result = spawnSync("npm", ["pack"], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`\nDone. Install with:\n`);
console.log(`  npm install -g ash-${pkg.version}.tgz\n`);
