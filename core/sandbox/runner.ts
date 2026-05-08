import { stat, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { FULL_IMAGE, ensureImage } from "./image.ts";
import { getRuntime, type ContainerRuntime } from "./runtime.ts";
import type { AgentType, RunResult } from "../../shared/types.ts";
import { loadAgentToken } from "../../cli/client.ts";
import { spawn } from "../util/spawn.ts";

import { ASH_DIR } from "../../cli/ash_dir.ts";

export interface SandboxOptions {
  taskDir: string;
  agent: AgentType;
  prompt: string;
  allowedHosts: string[];
  onLog?: (line: string) => void;
  timeoutMs?: number;
}

// Prompt is written to /task/prompt.txt inside the container; the command
// reads it via shell redirection so no user-controlled content is ever
// interpolated into the shell argument string.
//
// For Claude the token is read from the mounted secret file at invocation
// time and exported as CLAUDE_CODE_OAUTH_TOKEN — claude-code's supported env
// vars are CLAUDE_CODE_OAUTH_TOKEN (value) and
// CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR (fd). It does NOT read
// CLAUDE_CODE_OAUTH_TOKEN_FILE (path). Using shell substitution keeps the
// token value out of the container's argv / inspect output; it lives only
// in the claude process's own environment.
//
// For Codex the final assistant message is also written to
// /workspace/.ash_last.md via `--output-last-message`. The acceptor reads
// that file after the run and forwards only the clean final message to the
// requester — stdout (codex banner, streaming delta, token footer, prompt
// echo) is kept on the acceptor side only. `.ash_last.md` is listed in
// SANDBOX_FILES so it never appears in the task diff.
export const CODEX_LAST_MESSAGE_FILE = ".ash_last.md";

export function buildAgentCommand(agent: AgentType): string {
  if (agent === "claude") {
    return `export CLAUDE_CODE_OAUTH_TOKEN="$(cat /run/secrets/agent-token)" && unbuffer claude --dangerously-skip-permissions < /task/prompt.txt`;
  }
  return `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --output-last-message /workspace/${CODEX_LAST_MESSAGE_FILE} < /task/prompt.txt`;
}

export function networkMode(runtime: ContainerRuntime, hasHosts: boolean): string {
  if (!hasHosts) return "none";
  return runtime === "podman" ? "slirp4netns:allow_host_loopback=false" : "bridge";
}

// Cloud metadata services and well-known link-local hosts that an agent's
// outbound HTTP path could hit on a `--network=bridge` Docker container.
// Mapping these names to 127.0.0.1 in /etc/hosts neutralizes DNS-based
// exfiltration; direct-IP access to 169.254.169.254 still requires
// host-level firewall rules and is documented as a residual risk in
// README.md (see "Network exposure" notice).
const SANDBOX_BLOCKED_HOSTS = [
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
  "host.docker.internal",
  "gateway.docker.internal",
];

export async function runAgentInSandbox(opts: SandboxOptions): Promise<RunResult> {
  const { taskDir, agent, prompt, allowedHosts, onLog, timeoutMs = 25 * 60 * 1000 } = opts;

  const runtime = await getRuntime();
  await ensureImage();

  // Write prompt to a file so it is never interpolated into shell arguments.
  const promptFile = join(taskDir, "prompt.txt");
  await writeFile(promptFile, prompt, { encoding: "utf8" });

  const authArgs: string[] = [];

  if (agent === "claude") {
    const token = await loadAgentToken();
    if (!token) throw new Error("No agent token found. Run: ash init");
    // Write token to a file with restricted permissions so it is not exposed
    // as a plain env var in process listings or container inspect output.
    const tokenFile = join(taskDir, "agent-token");
    await writeFile(tokenFile, token, { encoding: "utf8" });
    await chmod(tokenFile, 0o600);
    authArgs.push(`--volume=${tokenFile}:/run/secrets/agent-token:ro`);
  } else if (agent === "codex") {
    const codexAuthDir = `${ASH_DIR}/codex-session/.codex`;
    try {
      await stat(`${codexAuthDir}/auth.json`);
    } catch {
      throw new Error("No Codex session found. Run: ash init");
    }
    // Read-only mount: a malicious payload must not be able to overwrite
    // the user's Codex session credentials on the host.
    authArgs.push(`--volume=${codexAuthDir}:/home/sandboxuser/.codex:ro`);
  }

  const blockedHosts = allowedHosts.length > 0
    ? SANDBOX_BLOCKED_HOSTS.flatMap((h) => ["--add-host", `${h}:127.0.0.1`])
    : [];

  const args: string[] = [
    "run", "--rm",
    `--network=${networkMode(runtime, allowedHosts.length > 0)}`,
    // `:Z` (uppercase) gives a private SELinux label per container —
    // lowercase `:z` would relabel the host file as shared-content,
    // which on multi-tenant SELinux hosts lets a sibling container
    // read+write the same files. Always use the private label.
    `--volume=${taskDir}:/workspace:Z`,
    // Mount taskDir read-only at /task so the agent command can read prompt.txt
    // and the agent-token secret without being able to write outside /workspace.
    `--volume=${taskDir}:/task:ro,Z`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=100m",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    ...blockedHosts,
    ...authArgs,
    "--workdir", "/workspace",
    FULL_IMAGE,
    buildAgentCommand(agent),
  ];

  const proc = spawn([runtime, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    onLine: onLog ? (_s, line) => onLog(line) : undefined,
  });

  const timeout = setTimeout(() => {
    proc.kill("SIGKILL");
  }, timeoutMs);

  try {
    const [code, stdout, stderr] = await Promise.all([proc.exited, proc.stdout, proc.stderr]);
    return { exitCode: code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}
