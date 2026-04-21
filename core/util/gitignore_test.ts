/**
 * Unit tests for core/util/gitignore.ts
 *
 * loadGitignorePatterns reads a directory's .gitignore and converts each
 * non-comment, non-empty pattern into an anchored RegExp.
 */

import { test, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGitignorePatterns } from "./gitignore.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ash-gitignore-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});

test("returns empty array when .gitignore does not exist", async () => {
  const dir = await makeTempDir();
  const patterns = await loadGitignorePatterns(dir);
  expect(patterns).toEqual([]);
});

test("returns empty array for an empty .gitignore file", async () => {
  const dir = await makeTempDir();
  await writeFile(join(dir, ".gitignore"), "");
  const patterns = await loadGitignorePatterns(dir);
  expect(patterns).toEqual([]);
});

test("returns empty array for a .gitignore with only comments", async () => {
  const dir = await makeTempDir();
  await writeFile(
    join(dir, ".gitignore"),
    "# this is a comment\n# another comment\n",
  );
  const patterns = await loadGitignorePatterns(dir);
  expect(patterns).toEqual([]);
});

test("returns empty array for a .gitignore with only blank lines", async () => {
  const dir = await makeTempDir();
  await writeFile(join(dir, ".gitignore"), "\n\n   \n");
  const patterns = await loadGitignorePatterns(dir);
  expect(patterns).toEqual([]);
});

test("*.log pattern matches foo.log and not foo.ts", async () => {
  const dir = await makeTempDir();
  await writeFile(join(dir, ".gitignore"), "*.log\n");
  const patterns = await loadGitignorePatterns(dir);
  expect(patterns.length).toEqual(1);
  expect(patterns[0]!.test("foo.log")).toEqual(true);
  expect(patterns[0]!.test("foo.ts")).toEqual(false);
});

test("node_modules pattern matches node_modules/foo", async () => {
  const dir = await makeTempDir();
  await writeFile(join(dir, ".gitignore"), "node_modules\n");
  const patterns = await loadGitignorePatterns(dir);
  expect(patterns.length).toEqual(1);
  expect(patterns[0]!.test("node_modules/foo")).toEqual(true);
  expect(patterns[0]!.test("src/app.ts")).toEqual(false);
});

test("? wildcard matches exactly one character", async () => {
  const dir = await makeTempDir();
  await writeFile(join(dir, ".gitignore"), "a?.txt\n");
  const patterns = await loadGitignorePatterns(dir);
  expect(patterns.length).toEqual(1);
  expect(patterns[0]!.test("ab.txt")).toEqual(true);
  expect(patterns[0]!.test("a1.txt")).toEqual(true);
  // Note: the implementation converts ? to ".", which matches any single char.
  // Two chars after "a" will not match because the regex anchors at (^|/)...(/|$)
  // and only one literal "?" maps to one "."
  expect(patterns[0]!.test("a.txt")).toEqual(false);
});

test("mixes comments, blanks and real patterns correctly", async () => {
  const dir = await makeTempDir();
  await writeFile(
    join(dir, ".gitignore"),
    "# header\n\n*.log\n# mid comment\nbuild\n\n",
  );
  const patterns = await loadGitignorePatterns(dir);
  expect(patterns.length).toEqual(2);
  expect(patterns.some((p) => p.test("error.log"))).toEqual(true);
  expect(patterns.some((p) => p.test("build"))).toEqual(true);
});
