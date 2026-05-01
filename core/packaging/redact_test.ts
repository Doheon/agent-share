/**
 * Regression tests for the GitHub-token / OAuth redaction regex used in
 * mine.ts. Without these, a refactor to the regex could quietly leak
 * the user's PAT into terminal scrollback when `git push` echoes a
 * credential URL.
 */

import { test, expect } from "vitest";

// Mirror of the redaction in cli/commands/mine.ts. If you change one,
// change the other and add a test case here.
function redactGitOutput(s: string): string {
  return s
    .replace(/oauth2:[^@\s]+@/g, "oauth2:***@")
    .replace(/gh[psuro]_[A-Za-z0-9_]{20,}/g, "gh*_***")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_***");
}

test("redacts oauth2 credential URL", () => {
  const input = "fatal: unable to access 'https://oauth2:ghp_abcdef1234567890abcdef@github.com/x/y.git'";
  const out = redactGitOutput(input);
  expect(out).not.toContain("ghp_abcdef1234567890abcdef");
  expect(out).toContain("oauth2:***@");
});

test("redacts ghp_ classic PAT", () => {
  const out = redactGitOutput("token leaked: ghp_abcdefghijklmnopqrstuvwxyz1234567890");
  expect(out).toContain("gh*_***");
  expect(out).not.toContain("ghp_abcdef");
});

test("redacts ghs_ App token", () => {
  const out = redactGitOutput("ghs_abcdefghijklmnopqrstuvwxyz1234567890");
  expect(out).toContain("gh*_***");
});

test("redacts ghu_ user-to-server OAuth", () => {
  const out = redactGitOutput("ghu_abcdefghijklmnopqrstuvwxyz1234567890");
  expect(out).toContain("gh*_***");
});

test("redacts ghr_ refresh token", () => {
  const out = redactGitOutput("ghr_abcdefghijklmnopqrstuvwxyz1234567890");
  expect(out).toContain("gh*_***");
});

test("redacts gho_ OAuth-app token", () => {
  const out = redactGitOutput("gho_abcdefghijklmnopqrstuvwxyz1234567890");
  expect(out).toContain("gh*_***");
});

test("redacts github_pat_ fine-grained PAT", () => {
  const out = redactGitOutput("github_pat_11ABCDEFG0abcdef1234567890_abcdefghij");
  expect(out).toContain("github_pat_***");
  expect(out).not.toContain("github_pat_11ABCDEFG0");
});

test("does not over-match plain text", () => {
  const out = redactGitOutput("normal output without secrets here");
  expect(out).toBe("normal output without secrets here");
});

test("handles multiple secrets on one line", () => {
  const out = redactGitOutput(
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890 and ghs_zyxwvutsrqponmlkjihgfedcba0987654321",
  );
  expect(out.match(/gh\*_\*\*\*/g)?.length).toBe(2);
});
