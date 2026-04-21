/**
 * Unit tests for core/util/spawn.ts
 *
 * Exercises the Node child_process wrapper: piped stdio collection, stdin
 * string injection, exit-code propagation, and the onLine callback.
 */

import { test, expect } from "vitest";
import { spawn } from "./spawn.ts";

// ─── basic execution ─────────────────────────────────────────────────────────

test("runs a simple command and resolves exit code 0", async () => {
  const proc = spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  const code = await proc.exited;
  expect(code).toEqual(0);
});

test("propagates non-zero exit code from the child", async () => {
  const proc = spawn(["false"], { stdout: "ignore", stderr: "ignore" });
  const code = await proc.exited;
  expect(code).not.toEqual(0);
});

test("returns 1 when command does not exist", async () => {
  const proc = spawn(["/nonexistent/path/definitely-not-a-command"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  expect(code).toEqual(1);
});

// ─── stdout / stderr piping ──────────────────────────────────────────────────

test("captures piped stdout as a string", async () => {
  const proc = spawn(["sh", "-c", "printf 'hello world'"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [code, stdout] = await Promise.all([proc.exited, proc.stdout]);
  expect(code).toEqual(0);
  expect(stdout).toEqual("hello world");
});

test("captures piped stderr as a string", async () => {
  const proc = spawn(["sh", "-c", "printf 'an error' 1>&2"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, proc.stderr]);
  expect(code).toEqual(0);
  expect(stderr).toEqual("an error");
});

test("non-pipe stdout resolves to empty string", async () => {
  const proc = spawn(["sh", "-c", "printf 'hidden'"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const [, stdout] = await Promise.all([proc.exited, proc.stdout]);
  expect(stdout).toEqual("");
});

// ─── stdin string injection ──────────────────────────────────────────────────

test("injects a stdin string and pipes it through cat", async () => {
  const proc = spawn(["cat"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "piped input text",
  });
  const [code, stdout] = await Promise.all([proc.exited, proc.stdout]);
  expect(code).toEqual(0);
  expect(stdout).toEqual("piped input text");
});

test("injects a multi-line stdin string correctly", async () => {
  const payload = "line1\nline2\nline3";
  const proc = spawn(["cat"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: payload,
  });
  const [code, stdout] = await Promise.all([proc.exited, proc.stdout]);
  expect(code).toEqual(0);
  expect(stdout).toEqual(payload);
});

// ─── onLine callback ─────────────────────────────────────────────────────────

test("invokes onLine for each complete stdout line", async () => {
  const lines: Array<{ stream: "stdout" | "stderr"; line: string }> = [];
  const proc = spawn(["sh", "-c", "printf 'a\\nb\\nc\\n'"], {
    stdout: "pipe",
    stderr: "ignore",
    onLine: (stream, line) => lines.push({ stream, line }),
  });
  const [code, stdout] = await Promise.all([proc.exited, proc.stdout]);
  expect(code).toEqual(0);
  expect(stdout).toEqual("a\nb\nc\n");
  // All 3 lines should be reported.
  const contentLines = lines.map((l) => l.line);
  expect(contentLines.includes("a")).toEqual(true);
  expect(contentLines.includes("b")).toEqual(true);
  expect(contentLines.includes("c")).toEqual(true);
  // Only stdout was piped.
  expect(lines.every((l) => l.stream === "stdout")).toEqual(true);
});

test("invokes onLine for stderr lines when stderr is piped", async () => {
  const lines: Array<{ stream: "stdout" | "stderr"; line: string }> = [];
  const proc = spawn(["sh", "-c", "printf 'err1\\nerr2\\n' 1>&2"], {
    stdout: "ignore",
    stderr: "pipe",
    onLine: (stream, line) => lines.push({ stream, line }),
  });
  await proc.exited;
  const errLines = lines.filter((l) => l.stream === "stderr").map((l) => l.line);
  expect(errLines.includes("err1")).toEqual(true);
  expect(errLines.includes("err2")).toEqual(true);
});

test("flushes the final partial line (no trailing newline) via onLine", async () => {
  const lines: string[] = [];
  const proc = spawn(["sh", "-c", "printf 'incomplete'"], {
    stdout: "pipe",
    stderr: "ignore",
    onLine: (_s, line) => lines.push(line),
  });
  await Promise.all([proc.exited, proc.stdout]);
  expect(lines.includes("incomplete")).toEqual(true);
});
