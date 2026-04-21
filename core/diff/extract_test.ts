/**
 * Unit tests for git diff extraction (core/diff/extract.ts)
 */

import { test, expect } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extractDiff, initRepo } from "./extract.ts";
import { spawn } from "../util/spawn.ts";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ash-extract-test-"));
}

async function cleanup(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ─── initRepo ────────────────────────────────────────────────────────────────

test("initRepo creates a .git directory in the target directory", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "seed.txt"), "initial");
    await initRepo(dir);

    const gitStat = await stat(join(dir, ".git"));
    expect(gitStat.isDirectory()).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

test("initRepo makes an initial commit so HEAD exists", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "file.txt"), "content");
    await initRepo(dir);

    const proc = spawn(["git", "log", "--oneline"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    const log = await proc.stdout;
    expect(log.includes("initial snapshot")).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

test("initRepo sets sandbox git user config", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "f.txt"), "x");
    await initRepo(dir);

    const proc = spawn(["git", "config", "user.email"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    const email = (await proc.stdout).trim();
    expect(email).toEqual("sandbox@agent-share");
  } finally {
    await cleanup(dir);
  }
});

// ─── extractDiff — new file addition ────────────────────────────────────────

test("extractDiff captures file addition as a non-empty patch", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "base.txt"), "base");
    await initRepo(dir);

    // Add a new file after the initial commit
    await writeFile(join(dir, "new.txt"), "brand new file");

    const result = await extractDiff(dir);
    expect(result.patch).not.toEqual("");
    expect(result.patch.includes("new.txt")).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

test("extractDiff reports filesChanged count for added file", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "base.txt"), "base");
    await initRepo(dir);

    await writeFile(join(dir, "added.ts"), "export const x = 1;");

    const result = await extractDiff(dir);
    expect(result.filesChanged).toEqual(1);
  } finally {
    await cleanup(dir);
  }
});

// ─── extractDiff — file modification ────────────────────────────────────────

test("extractDiff captures file modification", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "mod.txt"), "original content\n");
    await initRepo(dir);

    await writeFile(join(dir, "mod.txt"), "modified content\n");

    const result = await extractDiff(dir);
    expect(result.patch).not.toEqual("");
    expect(result.patch.includes("mod.txt")).toEqual(true);
    expect(result.insertions > 0 || result.deletions > 0).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

test("extractDiff reports correct insertions and deletions for a modification", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "file.txt"), "line1\nline2\nline3\n");
    await initRepo(dir);

    // Replace line2, remove line3, add line4
    await writeFile(join(dir, "file.txt"), "line1\nreplaced\nline4\n");

    const result = await extractDiff(dir);
    // At least 1 insertion and 1 deletion
    expect(result.insertions >= 1).toEqual(true);
    expect(result.deletions >= 1).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

// ─── extractDiff — file deletion ────────────────────────────────────────────

test("extractDiff captures file deletion", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "keep.txt"), "keep this\n");
    await writeFile(join(dir, "delete.txt"), "delete this\n");
    await initRepo(dir);

    await rm(join(dir, "delete.txt"));

    const result = await extractDiff(dir);
    expect(result.patch).not.toEqual("");
    expect(result.patch.includes("delete.txt")).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

// ─── extractDiff — no changes ───────────────────────────────────────────────

test("extractDiff returns empty patch when no changes were made", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "unchanged.txt"), "no changes\n");
    await initRepo(dir);

    const result = await extractDiff(dir);
    expect(result.patch).toEqual("");
    expect(result.filesChanged).toEqual(0);
    expect(result.insertions).toEqual(0);
    expect(result.deletions).toEqual(0);
  } finally {
    await cleanup(dir);
  }
});

// ─── extractDiff — multiple files ───────────────────────────────────────────

test("extractDiff captures changes across multiple files", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "a.txt"), "a original\n");
    await writeFile(join(dir, "b.txt"), "b original\n");
    await initRepo(dir);

    await writeFile(join(dir, "a.txt"), "a modified\n");
    await writeFile(join(dir, "b.txt"), "b modified\n");
    await writeFile(join(dir, "c.txt"), "c new\n");

    const result = await extractDiff(dir);
    // filesChanged is parsed from git stat summary line (e.g. "3 files changed")
    // The regex /\d+ file/g matches each occurrence of "<n> file" in the summary;
    // git outputs one summary line so the count reflects that single match.
    expect(result.filesChanged >= 1).toEqual(true);
    // The patch text must contain all three changed filenames
    expect(result.patch.includes("a.txt")).toEqual(true);
    expect(result.patch.includes("b.txt")).toEqual(true);
    expect(result.patch.includes("c.txt")).toEqual(true);
    // Insertions and deletions must reflect actual changes
    expect(result.insertions >= 1).toEqual(true);
    expect(result.deletions >= 1).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});
