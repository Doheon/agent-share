/**
 * Unit tests for sensitive information scanner (core/packaging/secret_scanner.ts)
 */

import { test, expect } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { scanDirectory, formatScanResults } from "./secret_scanner.ts";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ash-scanner-test-"));
}

async function cleanup(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ─── Content-based detection ─────────────────────────────────────────────────

test("detects AWS Access Key ID (AKIA...)", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "config.ts"), 'const key = "AKIAIOSFODNN7EXAMPLE";');
    const results = await scanDirectory(dir);
    const patterns = results.map((r) => r.pattern);
    expect(patterns.includes("AWS Access Key")).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

test("detects GitHub Personal Access Token (ghp_...)", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(
      join(dir, "config.ts"),
      'const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";',
    );
    const results = await scanDirectory(dir);
    const patterns = results.map((r) => r.pattern);
    expect(patterns.includes("GitHub Personal Access Token")).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

test("detects GitHub App Token (ghs_...)", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(
      join(dir, "app.ts"),
      'const appToken = "ghs_abcdefghijklmnopqrstuvwxyz1234567890";',
    );
    const results = await scanDirectory(dir);
    const patterns = results.map((r) => r.pattern);
    expect(patterns.includes("GitHub App Token")).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

test("detects OpenAI API Key (sk-...48chars)", async () => {
  const dir = await makeTempDir();
  try {
    const key = "sk-" + "a".repeat(48);
    await writeFile(join(dir, "openai.ts"), `const key = "${key}";`);
    const results = await scanDirectory(dir);
    const patterns = results.map((r) => r.pattern);
    expect(patterns.includes("OpenAI API Key")).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

test("detects Anthropic API Key (sk-ant-...)", async () => {
  const dir = await makeTempDir();
  try {
    const key = "sk-ant-" + "a".repeat(95);
    await writeFile(join(dir, "anthropic.ts"), `const key = "${key}";`);
    const results = await scanDirectory(dir);
    const patterns = results.map((r) => r.pattern);
    expect(patterns.includes("Anthropic API Key")).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

test("detects Database URL with embedded credentials", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(
      join(dir, "db.ts"),
      'const url = "postgres://user:password@localhost/mydb";',
    );
    const results = await scanDirectory(dir);
    const patterns = results.map((r) => r.pattern);
    expect(patterns.includes("Database URL with credentials")).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

// ─── Filename-based detection ────────────────────────────────────────────────

test(".env files are always excluded from scan (ALWAYS_SKIP rule)", async () => {
  // .env matches the ALWAYS_SKIP pattern /^\.env/, so the scanner never
  // processes it — even though it would match the sensitive filename list.
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, ".env"), "SECRET=abc");
    const results = await scanDirectory(dir);
    // The scanner skips .env entirely — no results expected
    expect(results.length).toEqual(0);
  } finally {
    await cleanup(dir);
  }
});

test("detects sensitive filename credentials.json", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "credentials.json"), '{"key":"value"}');
    const results = await scanDirectory(dir);
    const patterns = results.map((r) => r.pattern);
    expect(patterns.includes("Sensitive filename")).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

test("detects sensitive filename with .pem extension", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "cert.pem"), "not a real cert");
    const results = await scanDirectory(dir);
    const patterns = results.map((r) => r.pattern);
    expect(patterns.includes("Sensitive filename")).toEqual(true);
  } finally {
    await cleanup(dir);
  }
});

// ─── Normal code files are ignored ──────────────────────────────────────────

test("ignores normal TypeScript source files with no secrets", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(
      join(dir, "main.ts"),
      'export function add(a: number, b: number): number { return a + b; }',
    );
    const results = await scanDirectory(dir);
    expect(results.length).toEqual(0);
  } finally {
    await cleanup(dir);
  }
});

test("Private Key Block pattern does not match string literals in .ts source files", async () => {
  const dir = await makeTempDir();
  try {
    // A TypeScript file that mentions the PEM header as a string (not a real key)
    // The pattern anchors to start-of-line (^), so an indented string literal won't match
    await writeFile(
      join(dir, "parser.ts"),
      '  const header = "-----BEGIN RSA PRIVATE KEY-----";\n  // just parsing\n',
    );
    const results = await scanDirectory(dir);
    // The line starts with spaces, so the ^ anchor in the pattern should NOT match
    const privateKeyResults = results.filter((r) => r.pattern === "Private Key Block");
    expect(privateKeyResults.length).toEqual(0);
  } finally {
    await cleanup(dir);
  }
});

// ─── Always-skip directories ─────────────────────────────────────────────────

test("skips .git directory even if it contains secrets", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(
      join(dir, ".git", "config"),
      'const key = "AKIAIOSFODNN7EXAMPLE";',
    );
    const results = await scanDirectory(dir);
    expect(results.length).toEqual(0);
  } finally {
    await cleanup(dir);
  }
});

test("skips .claude directory even if it contains secrets", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "settings.json"),
      'const key = "AKIAIOSFODNN7EXAMPLE";',
    );
    const results = await scanDirectory(dir);
    expect(results.length).toEqual(0);
  } finally {
    await cleanup(dir);
  }
});

test("skips node_modules directory even if it contains secrets", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, "node_modules", "some-pkg"), { recursive: true });
    await writeFile(
      join(dir, "node_modules", "some-pkg", "index.js"),
      'const key = "AKIAIOSFODNN7EXAMPLE";',
    );
    // Also a sensitive filename under node_modules
    await writeFile(
      join(dir, "node_modules", "some-pkg", "credentials.json"),
      '{"key":"value"}',
    );
    const results = await scanDirectory(dir);
    expect(results.length).toEqual(0);
  } finally {
    await cleanup(dir);
  }
});

test("skips .omc directory even if it contains secrets", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, ".omc"), { recursive: true });
    await writeFile(
      join(dir, ".omc", "state.json"),
      'const key = "AKIAIOSFODNN7EXAMPLE";',
    );
    const results = await scanDirectory(dir);
    expect(results.length).toEqual(0);
  } finally {
    await cleanup(dir);
  }
});

test("respects .gitignore patterns and skips matched files", async () => {
  const dir = await makeTempDir();
  try {
    // Use a filename-level pattern that the scanner's glob→regex handles correctly.
    // Pattern "secret_keys.ts" will match that exact filename via regex.
    await writeFile(join(dir, ".gitignore"), "secret_keys.ts\n");
    await writeFile(
      join(dir, "secret_keys.ts"),
      'const key = "AKIAIOSFODNN7EXAMPLE";',
    );
    // Safe file that must not produce results
    await writeFile(join(dir, "main.ts"), "export const x = 1;");

    const results = await scanDirectory(dir);
    expect(results.length).toEqual(0);
  } finally {
    await cleanup(dir);
  }
});

// ─── formatScanResults ───────────────────────────────────────────────────────

test("formatScanResults returns empty string when no results", () => {
  const output = formatScanResults([]);
  expect(output).toEqual("");
});

test("formatScanResults includes pattern name, file path and match snippet", () => {
  const results = [
    { file: "config.ts", line: 5, pattern: "AWS Access Key", match: "AKIAIOSFODNN7EXAMPLE" },
  ];
  const output = formatScanResults(results);
  expect(output.includes("AWS Access Key")).toEqual(true);
  expect(output.includes("config.ts")).toEqual(true);
  expect(output.includes("AKIAIOSFODNN7EXAMPLE")).toEqual(true);
});

test("formatScanResults shows line 0 results without line number suffix", () => {
  const results = [
    { file: ".env", line: 0, pattern: "Sensitive filename", match: ".env" },
  ];
  const output = formatScanResults(results);
  // line 0 should show just the filename, not filename:0
  expect(output.includes(".env:0")).toEqual(false);
  expect(output.includes(".env")).toEqual(true);
});
