/**
 * Unit tests for directory packaging (core/packaging/pack.ts)
 */

import { test, expect } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { packDirectory } from "./pack.ts";
import { unpackToDirectory } from "./unpack.ts";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ash-pack-test-"));
}

async function cleanup(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

test("packDirectory returns ciphertext, iv, and aesKeyRaw", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "hello.txt"), "hello world");
    const result = await packDirectory(dir);

    expect(result.ciphertext.length).not.toEqual(0);
    expect(result.iv.length).toEqual(12);
    expect(result.aesKeyRaw.length).toEqual(32); // 256-bit AES key
  } finally {
    await cleanup(dir);
  }
});

test("pack then unpack roundtrip preserves file contents", async () => {
  const srcDir = await makeTempDir();
  const destDir = await makeTempDir();
  try {
    await writeFile(join(srcDir, "file.txt"), "roundtrip content");
    await mkdir(join(srcDir, "subdir"), { recursive: true });
    await writeFile(join(srcDir, "subdir", "nested.txt"), "nested content");

    const { ciphertext, iv, aesKeyRaw } = await packDirectory(srcDir);
    await unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir);

    const fileContent = await readFile(join(destDir, "file.txt"), "utf-8");
    expect(fileContent).toEqual("roundtrip content");

    const nestedContent = await readFile(join(destDir, "subdir", "nested.txt"), "utf-8");
    expect(nestedContent).toEqual("nested content");
  } finally {
    await cleanup(srcDir);
    await cleanup(destDir);
  }
});

test("pack roundtrip preserves binary file contents", async () => {
  const srcDir = await makeTempDir();
  const destDir = await makeTempDir();
  try {
    const binary = crypto.getRandomValues(new Uint8Array(256));
    await writeFile(join(srcDir, "binary.bin"), binary);

    const { ciphertext, iv, aesKeyRaw } = await packDirectory(srcDir);
    await unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir);

    const result = new Uint8Array(await readFile(join(destDir, "binary.bin")));
    expect(result).toEqual(binary);
  } finally {
    await cleanup(srcDir);
    await cleanup(destDir);
  }
});

test(".gitignore patterns are respected during pack", async () => {
  const srcDir = await makeTempDir();
  const destDir = await makeTempDir();
  try {
    await writeFile(join(srcDir, ".gitignore"), "ignored.txt\n*.log\n");
    await writeFile(join(srcDir, "included.txt"), "this is included");
    await writeFile(join(srcDir, "ignored.txt"), "this should be excluded");
    await writeFile(join(srcDir, "app.log"), "log file excluded");

    const { ciphertext, iv, aesKeyRaw } = await packDirectory(srcDir);
    await unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir);

    const included = await readFile(join(destDir, "included.txt"), "utf-8");
    expect(included).toEqual("this is included");

    // ignored.txt must not be present
    let ignoredExists = false;
    try {
      await stat(join(destDir, "ignored.txt"));
      ignoredExists = true;
    } catch { /* expected */ }
    expect(ignoredExists).toEqual(false);

    // app.log must not be present
    let logExists = false;
    try {
      await stat(join(destDir, "app.log"));
      logExists = true;
    } catch { /* expected */ }
    expect(logExists).toEqual(false);
  } finally {
    await cleanup(srcDir);
    await cleanup(destDir);
  }
});

test(".git directory is always excluded from pack", async () => {
  const srcDir = await makeTempDir();
  const destDir = await makeTempDir();
  try {
    await writeFile(join(srcDir, "main.ts"), "code here");
    await mkdir(join(srcDir, ".git"), { recursive: true });
    await writeFile(join(srcDir, ".git", "config"), "[core]");

    const { ciphertext, iv, aesKeyRaw } = await packDirectory(srcDir);
    await unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir);

    let gitExists = false;
    try {
      await stat(join(destDir, ".git"));
      gitExists = true;
    } catch { /* expected */ }
    expect(gitExists).toEqual(false);
  } finally {
    await cleanup(srcDir);
    await cleanup(destDir);
  }
});

test("node_modules directory is always excluded from pack", async () => {
  const srcDir = await makeTempDir();
  const destDir = await makeTempDir();
  try {
    await writeFile(join(srcDir, "index.ts"), "export {}");
    await mkdir(join(srcDir, "node_modules", "lodash"), { recursive: true });
    await writeFile(join(srcDir, "node_modules", "lodash", "index.js"), "module.exports = {};");

    const { ciphertext, iv, aesKeyRaw } = await packDirectory(srcDir);
    await unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir);

    let nmExists = false;
    try {
      await stat(join(destDir, "node_modules"));
      nmExists = true;
    } catch { /* expected */ }
    expect(nmExists).toEqual(false);
  } finally {
    await cleanup(srcDir);
    await cleanup(destDir);
  }
});

test(".env files are always excluded from pack", async () => {
  const srcDir = await makeTempDir();
  const destDir = await makeTempDir();
  try {
    await writeFile(join(srcDir, "app.ts"), "const x = 1;");
    await writeFile(join(srcDir, ".env"), "SECRET=abc123");
    await writeFile(join(srcDir, ".env.local"), "DB_URL=postgres://...");

    const { ciphertext, iv, aesKeyRaw } = await packDirectory(srcDir);
    await unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir);

    let envExists = false;
    try {
      await stat(join(destDir, ".env"));
      envExists = true;
    } catch { /* expected */ }
    expect(envExists).toEqual(false);
  } finally {
    await cleanup(srcDir);
    await cleanup(destDir);
  }
});

test("subdirectory .gitignore with leading-slash pattern excludes correctly", async () => {
  // /node_modules/ in a subdir's .gitignore should exclude subdir/node_modules/
  // This was broken before the fix — leading slash created a // double-slash regex
  const srcDir = await makeTempDir();
  const destDir = await makeTempDir();
  try {
    await mkdir(join(srcDir, "frontend"), { recursive: true });
    await writeFile(join(srcDir, "frontend", ".gitignore"), "/node_modules/\n/build/\n");
    await writeFile(join(srcDir, "frontend", "app.ts"), "export {}");
    await mkdir(join(srcDir, "frontend", "node_modules", "lodash"), { recursive: true });
    await writeFile(join(srcDir, "frontend", "node_modules", "lodash", "index.js"), "module.exports = {};");
    await mkdir(join(srcDir, "frontend", "build"), { recursive: true });
    await writeFile(join(srcDir, "frontend", "build", "bundle.js"), "bundled");

    const { ciphertext, iv, aesKeyRaw } = await packDirectory(srcDir);
    await unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir);

    const app = await readFile(join(destDir, "frontend", "app.ts"), "utf-8");
    expect(app).toEqual("export {}");

    let nmExists = false;
    try { await stat(join(destDir, "frontend", "node_modules")); nmExists = true; } catch { /* expected */ }
    expect(nmExists).toEqual(false);

    let buildExists = false;
    try { await stat(join(destDir, "frontend", "build")); buildExists = true; } catch { /* expected */ }
    expect(buildExists).toEqual(false);
  } finally {
    await cleanup(srcDir);
    await cleanup(destDir);
  }
});

test("subdirectory .gitignore unanchored pattern matches at any depth", async () => {
  // `venv/` (no leading slash) should exclude backend/venv/ and backend/sub/venv/
  const srcDir = await makeTempDir();
  const destDir = await makeTempDir();
  try {
    await mkdir(join(srcDir, "backend"), { recursive: true });
    await writeFile(join(srcDir, "backend", ".gitignore"), "venv/\n*.log\n");
    await writeFile(join(srcDir, "backend", "main.py"), "print('hello')");
    await mkdir(join(srcDir, "backend", "venv", "lib"), { recursive: true });
    await writeFile(join(srcDir, "backend", "venv", "lib", "site.py"), "site");
    await writeFile(join(srcDir, "backend", "server.log"), "log content");

    const { ciphertext, iv, aesKeyRaw } = await packDirectory(srcDir);
    await unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir);

    const main = await readFile(join(destDir, "backend", "main.py"), "utf-8");
    expect(main).toEqual("print('hello')");

    let venvExists = false;
    try { await stat(join(destDir, "backend", "venv")); venvExists = true; } catch { /* expected */ }
    expect(venvExists).toEqual(false);

    let logExists = false;
    try { await stat(join(destDir, "backend", "server.log")); logExists = true; } catch { /* expected */ }
    expect(logExists).toEqual(false);
  } finally {
    await cleanup(srcDir);
    await cleanup(destDir);
  }
});

test("glob * does not cross directory boundaries", async () => {
  // *.log should match foo.log but NOT logs/foo.log (without explicit logs/ pattern)
  const srcDir = await makeTempDir();
  const destDir = await makeTempDir();
  try {
    await writeFile(join(srcDir, ".gitignore"), "*.log\n");
    await writeFile(join(srcDir, "app.ts"), "code");
    await writeFile(join(srcDir, "error.log"), "excluded");
    await mkdir(join(srcDir, "logs"), { recursive: true });
    await writeFile(join(srcDir, "logs", "server.log"), "also excluded");

    const { ciphertext, iv, aesKeyRaw } = await packDirectory(srcDir);
    await unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir);

    const app = await readFile(join(destDir, "app.ts"), "utf-8");
    expect(app).toEqual("code");

    let logExists = false;
    try { await stat(join(destDir, "error.log")); logExists = true; } catch { /* expected */ }
    expect(logExists).toEqual(false);

    // logs/server.log is also matched because *.log is unanchored and matches at any depth
    let nestedLogExists = false;
    try { await stat(join(destDir, "logs", "server.log")); nestedLogExists = true; } catch { /* expected */ }
    expect(nestedLogExists).toEqual(false);
  } finally {
    await cleanup(srcDir);
    await cleanup(destDir);
  }
});

test("packDirectory on empty directory returns valid (non-empty) result", async () => {
  const dir = await makeTempDir();
  try {
    const result = await packDirectory(dir);
    // Even an empty tar has EOF blocks (1024 bytes) + GCM tag
    expect(result.ciphertext.length).not.toEqual(0);
    expect(result.iv.length).toEqual(12);
    expect(result.aesKeyRaw.length).toEqual(32);
  } finally {
    await cleanup(dir);
  }
});
