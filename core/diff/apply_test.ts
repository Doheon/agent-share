/**
 * Unit tests for git patch validation and application (core/diff/apply.ts)
 *
 * Tests that need a patch against a real git repo generate it with
 * `git diff` so the blob hashes in the `index` line match reality —
 * hand-crafted patches with fake index lines can fool `git apply --check`
 * on some git versions.
 */

import { test, expect } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { applyPatch, checkPatch, getChangedFiles, summarizePatch } from "./apply.ts";
import { initRepo } from "../diff/extract.ts";
import { spawn } from "../util/spawn.ts";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ash-apply-test-"));
}

async function cleanup(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/** Create a real git repo with an initial file and return the dir */
async function makeGitRepo(files: Record<string, string> = {}): Promise<string> {
  const dir = await makeTempDir();
  const hasFiles = Object.keys(files).length > 0;
  if (!hasFiles) {
    await writeFile(join(dir, ".gitkeep"), "");
  }
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    const parent = filePath.split("/").slice(0, -1).join("/");
    await mkdir(parent, { recursive: true });
    await writeFile(filePath, content);
  }
  await initRepo(dir);
  return dir;
}

/**
 * Create a real unified diff for changing `filename` from its current committed
 * content (which must already be in the repo) to `newContent`.
 * Does this by temporarily overwriting the file, running `git diff`, then
 * restoring the original so the working tree remains committed-clean.
 */
async function realPatch(
  dir: string,
  filename: string,
  originalContent: string,
  newContent: string,
): Promise<string> {
  const filePath = join(dir, filename);
  await writeFile(filePath, newContent);
  const proc = spawn(["git", "diff"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [code, patch] = await Promise.all([proc.exited, proc.stdout]);
  if (code !== 0) throw new Error("git diff failed");
  // Restore the original so applyPatch/checkPatch can work against a clean tree.
  await writeFile(filePath, originalContent);
  return patch;
}

// ─── checkPatch ───────────────────────────────────────────────────────────────

test("checkPatch returns success true for a valid patch", async () => {
  const dir = await makeGitRepo({ "hello.txt": "line one\n" });
  try {
    const patch = await realPatch(dir, "hello.txt", "line one\n", "line two\n");
    const result = await checkPatch(patch, dir);
    expect(result.success).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

test("checkPatch returns success false for a patch against non-existent file", async () => {
  const dir = await makeGitRepo({ "exists.txt": "hi\n" });
  try {
    // Build a plausible patch that references a file that doesn't exist in the repo.
    const patch = [
      "diff --git a/nonexistent.txt b/nonexistent.txt",
      "index 0000000..1111111 100644",
      "--- a/nonexistent.txt",
      "+++ b/nonexistent.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const result = await checkPatch(patch, dir);
    expect(result.success).toEqual(false);
  } finally {
    await cleanup(dir);
  }
});

test("checkPatch returns success false for an empty string (invalid patch)", async () => {
  const dir = await makeGitRepo({ "file.txt": "content\n" });
  try {
    const result = await checkPatch("", dir);
    expect(result.success).toEqual(false);
  } finally {
    await cleanup(dir);
  }
});

test("checkPatch returns conflicts array when patch fails", async () => {
  const dir = await makeGitRepo({ "exists.txt": "hi\n" });
  try {
    const patch = [
      "diff --git a/missing.txt b/missing.txt",
      "index 0000000..1111111 100644",
      "--- a/missing.txt",
      "+++ b/missing.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const result = await checkPatch(patch, dir);
    expect(result.success).toEqual(false);
    // conflicts should be defined (possibly empty but not undefined)
    expect(result.conflicts).not.toEqual(undefined);
  } finally {
    await cleanup(dir);
  }
});

// ─── applyPatch ───────────────────────────────────────────────────────────────

test("applyPatch modifies the file content in the target directory", async () => {
  const dir = await makeGitRepo({ "apply.txt": "original\n" });
  try {
    const patch = await realPatch(dir, "apply.txt", "original\n", "modified\n");
    const result = await applyPatch(patch, dir);
    expect(result.success).toEqual(true);

    const content = await readFile(join(dir, "apply.txt"), "utf-8");
    expect(content).toEqual("modified\n");
  } finally {
    await cleanup(dir);
  }
});

test("applyPatch returns success false and does not modify files for invalid patch", async () => {
  const dir = await makeGitRepo({ "stable.txt": "unchanged\n" });
  try {
    const badPatch = [
      "diff --git a/nonexistent.txt b/nonexistent.txt",
      "index 0000000..1111111 100644",
      "--- a/nonexistent.txt",
      "+++ b/nonexistent.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const result = await applyPatch(badPatch, dir);
    expect(result.success).toEqual(false);

    // stable.txt must be untouched
    const content = await readFile(join(dir, "stable.txt"), "utf-8");
    expect(content).toEqual("unchanged\n");
  } finally {
    await cleanup(dir);
  }
});

// ─── getChangedFiles ─────────────────────────────────────────────────────────

test("getChangedFiles returns the correct list of changed filenames", () => {
  const patch = [
    "diff --git a/src/main.ts b/src/main.ts",
    "index abc..def 100644",
    "--- a/src/main.ts",
    "+++ b/src/main.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/README.md b/README.md",
    "index 111..222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-old readme",
    "+new readme",
  ].join("\n");

  const files = getChangedFiles(patch);
  expect(files.length).toEqual(2);
  expect(files[0]).toEqual("src/main.ts");
  expect(files[1]).toEqual("README.md");
});

test("getChangedFiles returns empty array for patch with no diff headers", () => {
  const files = getChangedFiles("not a valid patch");
  expect(files).toEqual([]);
});

test("getChangedFiles returns empty array for empty string", () => {
  expect(getChangedFiles("")).toEqual([]);
});

// ─── summarizePatch ───────────────────────────────────────────────────────────

test("summarizePatch reports correct file count and file names", () => {
  const patch = [
    "diff --git a/foo.ts b/foo.ts",
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -1,2 +1,3 @@",
    " unchanged",
    "-removed line",
    "+added line 1",
    "+added line 2",
  ].join("\n");

  const summary = summarizePatch(patch);
  expect(summary.includes("1 file(s) changed")).toEqual(true);
  expect(summary.includes("foo.ts")).toEqual(true);
  expect(summary.includes("+2")).toEqual(true);
  expect(summary.includes("-1")).toEqual(true);
});

test("summarizePatch shows 0 files changed for empty patch", () => {
  const summary = summarizePatch("");
  expect(summary.includes("0 file(s) changed")).toEqual(true);
});

test("summarizePatch counts additions and deletions correctly", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-delete me",
    "+add me",
    "+add me too",
  ].join("\n");

  const summary = summarizePatch(patch);
  expect(summary.includes("+2")).toEqual(true);
  expect(summary.includes("-1")).toEqual(true);
});
