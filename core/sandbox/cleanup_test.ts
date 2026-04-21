/**
 * Unit tests for core/sandbox/cleanup.ts
 *
 * Covers: taskDir (validation + path composition) and ensureTaskDir
 * (directory creation and replacement of existing directory).
 */

import { test, expect } from "vitest";
import { join } from "node:path";
import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import { taskDir, ensureTaskDir } from "./cleanup.ts";

const TASK_BASE_DIR = join(process.env.TMPDIR ?? "/tmp", "agent-share");

// ─── taskDir — valid IDs ──────────────────────────────────────────────────────

test("taskDir accepts alphanumeric ID", () => {
  expect(() => taskDir("abc123")).not.toThrow();
});

test("taskDir accepts ID with dashes", () => {
  expect(() => taskDir("task-id-123")).not.toThrow();
});

test("taskDir accepts ID with underscores", () => {
  expect(() => taskDir("task_id_123")).not.toThrow();
});

test("taskDir accepts mixed alphanumeric, dash, and underscore", () => {
  expect(() => taskDir("My_Task-01")).not.toThrow();
});

// ─── taskDir — invalid IDs ────────────────────────────────────────────────────

test("taskDir throws 'Invalid taskId' for path traversal '../etc'", () => {
  expect(() => taskDir("../etc")).toThrow("Invalid taskId");
});

test("taskDir throws 'Invalid taskId' for path traversal '../../root'", () => {
  expect(() => taskDir("../../root")).toThrow("Invalid taskId");
});

test("taskDir throws 'Invalid taskId' for slash-separated path 'foo/bar'", () => {
  expect(() => taskDir("foo/bar")).toThrow("Invalid taskId");
});

test("taskDir throws 'Invalid taskId' for backslash-separated path 'foo\\bar'", () => {
  expect(() => taskDir("foo\\bar")).toThrow("Invalid taskId");
});

test("taskDir throws 'Invalid taskId' for ID with space 'hello world'", () => {
  expect(() => taskDir("hello world")).toThrow("Invalid taskId");
});

test("taskDir throws 'Invalid taskId' for ID with semicolon 'foo;rm -rf /'", () => {
  expect(() => taskDir("foo;rm -rf /")).toThrow("Invalid taskId");
});

test("taskDir throws 'Invalid taskId' for ID with subshell 'foo$(whoami)'", () => {
  expect(() => taskDir("foo$(whoami)")).toThrow("Invalid taskId");
});

test("taskDir throws 'Invalid taskId' for empty string", () => {
  expect(() => taskDir("")).toThrow("Invalid taskId");
});

// ─── taskDir — returned path ──────────────────────────────────────────────────

test("taskDir returned path contains TASK_BASE_DIR segment", () => {
  const result = taskDir("myTask");
  expect(result.startsWith(TASK_BASE_DIR)).toBe(true);
});

test("taskDir returned path ends with the taskId", () => {
  const id = "myTask";
  const result = taskDir(id);
  expect(result.endsWith(id)).toBe(true);
});

test("taskDir returned path is TASK_BASE_DIR joined with taskId", () => {
  const id = "some-task";
  expect(taskDir(id)).toEqual(join(TASK_BASE_DIR, id));
});

// ─── ensureTaskDir ────────────────────────────────────────────────────────────

test("ensureTaskDir creates the directory and returns its path", async () => {
  const id = `test-create-${Date.now()}`;
  const dir = join(TASK_BASE_DIR, id);
  try {
    const returned = await ensureTaskDir(id);
    expect(returned).toEqual(dir);
    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureTaskDir replaces an existing directory (old files are removed)", async () => {
  const id = `test-replace-${Date.now()}`;
  const dir = join(TASK_BASE_DIR, id);
  try {
    // Create the directory with a sentinel file first.
    await mkdir(dir, { recursive: true });
    const sentinel = join(dir, "old-file.txt");
    await writeFile(sentinel, "old content");

    await ensureTaskDir(id);

    // Sentinel must be gone.
    let exists = true;
    try {
      await stat(sentinel);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    // Directory itself must still exist.
    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
