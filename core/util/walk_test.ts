/**
 * Unit tests for core/util/walk.ts
 *
 * walk() is an async generator that yields WalkEntry objects for every file
 * and directory under the given root (recursive, depth-first).
 */

import { test, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walk, type WalkEntry } from "./walk.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "walk_test_"));
  tempDirs.push(dir);
  return dir;
}

async function collect(dir: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  for await (const e of walk(dir)) out.push(e);
  return out;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});

test("yields nothing for an empty directory", async () => {
  const dir = await makeTempDir();
  const entries = await collect(dir);
  expect(entries).toEqual([]);
});

test("yields each file in a flat directory", async () => {
  const dir = await makeTempDir();
  await writeFile(join(dir, "a.txt"), "a");
  await writeFile(join(dir, "b.txt"), "b");
  await writeFile(join(dir, "c.txt"), "c");

  const entries = await collect(dir);
  const names = entries.map((e) => e.name).sort();
  expect(names).toEqual(["a.txt", "b.txt", "c.txt"]);
  for (const e of entries) {
    expect(e.isFile).toEqual(true);
    expect(e.isDirectory).toEqual(false);
    expect(e.path.startsWith(dir)).toEqual(true);
  }
});

test("recurses into nested directories", async () => {
  const dir = await makeTempDir();
  await mkdir(join(dir, "sub1"), { recursive: true });
  await mkdir(join(dir, "sub1", "sub2"), { recursive: true });
  await writeFile(join(dir, "top.txt"), "top");
  await writeFile(join(dir, "sub1", "mid.txt"), "mid");
  await writeFile(join(dir, "sub1", "sub2", "deep.txt"), "deep");

  const entries = await collect(dir);
  const files = entries.filter((e) => e.isFile).map((e) => e.name).sort();
  const dirs = entries.filter((e) => e.isDirectory).map((e) => e.name).sort();

  expect(files).toEqual(["deep.txt", "mid.txt", "top.txt"]);
  expect(dirs).toEqual(["sub1", "sub2"]);
});

test("correctly flags files vs directories", async () => {
  const dir = await makeTempDir();
  await mkdir(join(dir, "adir"), { recursive: true });
  await writeFile(join(dir, "afile.txt"), "x");

  const entries = await collect(dir);
  const fileEntry = entries.find((e) => e.name === "afile.txt");
  const dirEntry = entries.find((e) => e.name === "adir");

  expect(fileEntry?.isFile).toEqual(true);
  expect(fileEntry?.isDirectory).toEqual(false);
  expect(dirEntry?.isFile).toEqual(false);
  expect(dirEntry?.isDirectory).toEqual(true);
});

test("treats symlinks without descending (so no infinite loop)", async () => {
  const dir = await makeTempDir();
  await mkdir(join(dir, "real"), { recursive: true });
  await writeFile(join(dir, "real", "x.txt"), "x");

  // Create a symlink that points back to the parent dir. If walk() followed
  // symlinked directories it would loop forever. readdir(withFileTypes) marks
  // symlinks as NOT directories, so walk() skips recursion into them.
  try {
    await symlink(dir, join(dir, "loop"));
  } catch {
    // Platforms without symlink permission: nothing to verify, pass trivially.
    return;
  }

  const entries = await collect(dir);
  const names = entries.map((e) => e.name).sort();
  // We expect to see `real`, `real/x.txt`, and `loop` (as a non-directory entry).
  expect(names.includes("real")).toEqual(true);
  expect(names.includes("x.txt")).toEqual(true);
  expect(names.includes("loop")).toEqual(true);

  // walk() must terminate — this assertion implicitly confirmed by arriving here.
  expect(entries.length < 100).toEqual(true);
});
