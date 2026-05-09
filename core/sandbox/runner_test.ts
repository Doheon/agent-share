/**
 * Unit tests for sandbox agent command builder (core/sandbox/runner.ts)
 *
 * Tests the real exported buildAgentCommand and networkMode functions, no
 * Podman/Docker invocations or network calls here.
 *
 * buildAgentCommand now takes only the agent type. Prompts are written to
 * /task/prompt.txt before container launch and read via shell stdin redirection,
 * so no user-controlled content is ever interpolated into the command string.
 */

import { test, expect } from "vitest";
import { buildAgentCommand, networkMode } from "./runner.ts";

// ─── buildAgentCommand: claude ────────────────────────────────────────────────

const CLAUDE_CMD =
  `export CLAUDE_CODE_OAUTH_TOKEN="$(cat /run/secrets/agent-token)" && claude --dangerously-skip-permissions --print --output-format stream-json --verbose < /task/prompt.txt`;

test("buildAgentCommand for claude uses stdin redirection from /task/prompt.txt", () => {
  const cmd = buildAgentCommand("claude");
  expect(cmd).toEqual(CLAUDE_CMD);
});

test("buildAgentCommand for claude includes --dangerously-skip-permissions flag", () => {
  const cmd = buildAgentCommand("claude");
  expect(cmd.includes("--dangerously-skip-permissions")).toEqual(true);
});

test("buildAgentCommand for claude loads the token from the mounted secret file", () => {
  const cmd = buildAgentCommand("claude");
  // claude-code honors CLAUDE_CODE_OAUTH_TOKEN (value), not ..._FILE (path).
  expect(cmd.includes(`CLAUDE_CODE_OAUTH_TOKEN="$(cat /run/secrets/agent-token)"`)).toEqual(true);
  expect(cmd.includes("CLAUDE_CODE_OAUTH_TOKEN_FILE")).toEqual(false);
});

test("buildAgentCommand for claude does not interpolate any prompt text", () => {
  const cmd = buildAgentCommand("claude");
  // Command must be deterministic and contain no user-supplied content
  expect(cmd).toEqual(CLAUDE_CMD);
});

// ─── buildAgentCommand: codex ─────────────────────────────────────────────────

test("buildAgentCommand for codex uses stdin redirection from /task/prompt.txt", () => {
  const cmd = buildAgentCommand("codex");
  expect(cmd).toEqual(
    "codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --output-last-message /workspace/.ash_last.md < /task/prompt.txt",
  );
});

test("buildAgentCommand for codex uses exec subcommand (not -p)", () => {
  const cmd = buildAgentCommand("codex");
  expect(cmd.startsWith("codex exec ")).toEqual(true);
  expect(cmd.includes("--dangerously-bypass-approvals-and-sandbox")).toEqual(true);
  expect(cmd.includes("--skip-git-repo-check")).toEqual(true);
});

test("buildAgentCommand for codex reads prompt from file, not shell arg", () => {
  const cmd = buildAgentCommand("codex");
  expect(cmd.includes("< /task/prompt.txt")).toEqual(true);
  // No single-quoted prompt argument present
  expect(cmd.includes("'")).toEqual(false);
});

// ─── injection safety ─────────────────────────────────────────────────────────

test("buildAgentCommand output contains no shell-interpolatable user content", () => {
  // The command string is static — no prompt text embedded
  const claudeCmd = buildAgentCommand("claude");
  const codexCmd = buildAgentCommand("codex");
  // Both commands must be identical on every call (no prompt arg)
  expect(claudeCmd).toEqual(CLAUDE_CMD);
  expect(codexCmd).toEqual(
    "codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --output-last-message /workspace/.ash_last.md < /task/prompt.txt",
  );
});

// ─── networkMode ─────────────────────────────────────────────────────────────

test("networkMode returns 'none' for podman with no allowed hosts", () => {
  expect(networkMode("podman", false)).toEqual("none");
});

test("networkMode returns 'none' for docker with no allowed hosts", () => {
  expect(networkMode("docker", false)).toEqual("none");
});

test("networkMode returns slirp4netns for podman when hosts are allowed", () => {
  expect(networkMode("podman", true)).toEqual("slirp4netns:allow_host_loopback=false");
});

test("networkMode returns 'bridge' for docker when hosts are allowed", () => {
  expect(networkMode("docker", true)).toEqual("bridge");
});
