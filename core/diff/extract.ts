import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiffResult } from "../../shared/types.ts";
import { spawn } from "../util/spawn.ts";

const SANDBOX_FILES = ["prompt.txt", "agent-token", ".ash_last.md"];

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const proc = spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, proc.stdout, proc.stderr]);
  return { success: exitCode === 0, stdout, stderr };
}

export async function initRepo(workDir: string): Promise<void> {
  await runGit(["init"], workDir);
  await runGit(["config", "user.email", "sandbox@agent-share"], workDir);
  await runGit(["config", "user.name", "Sandbox"], workDir);

  // Exclude sandbox infrastructure files from diffs regardless of creation order.
  const gitignorePath = join(workDir, ".gitignore");
  let existing = "";
  try { existing = await readFile(gitignorePath, "utf8"); } catch { /* no .gitignore yet */ }
  const toAdd = SANDBOX_FILES.filter((f) => !existing.split("\n").includes(f));
  if (toAdd.length > 0) {
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(gitignorePath, existing + sep + toAdd.join("\n") + "\n", "utf8");
  }

  await runGit(["add", "-A"], workDir);
  // --allow-empty lets initRepo succeed when the unpacked project is empty
  // (e.g. requester ran `ash` from a directory that was entirely ignored).
  const { success, stderr } = await runGit(["commit", "--allow-empty", "-m", "initial snapshot"], workDir);
  if (!success) throw new Error(`Initial commit failed: ${stderr}`);
  await runGit(["tag", "ash-initial"], workDir);
}

export async function extractDiff(workDir: string, logger?: (s: string) => void): Promise<DiffResult> {
  await runGit(["add", "-A"], workDir);
  // Commit any remaining changes so the full diff (including agent's own commits) is captured.
  await runGit(["commit", "--allow-empty", "-m", "ash-work-end"], workDir);

  const { stdout: patch, stderr: diffErr, success: diffOk } =
    await runGit(["diff", "ash-initial..HEAD", "--unified=3"], workDir);
  const { stdout: numstat } = await runGit(["diff", "ash-initial..HEAD", "--numstat"], workDir);

  if (!patch.trim()) {
    // Surface diagnostics so the acceptor (and requester via task:log) can see why.
    const { stdout: log } = await runGit(["log", "--oneline", "--all"], workDir);
    const { stdout: status } = await runGit(["status", "--short"], workDir);
    const diagLines = [
      `git log: ${log.trim().replace(/\n/g, " | ") || "(empty)"}`,
      `git status: ${status.trim() || "(clean)"}`,
      ...(diffErr.trim() ? [`git diff stderr: ${diffErr.trim()}`] : []),
    ];
    for (const line of diagLines) {
      (logger ?? ((s) => console.error("[ash]", s)))(line);
    }
    if (!diffOk && diffErr.includes("ash-initial")) {
      (logger ?? ((s) => console.error("[ash]", s)))(
        "ash-initial tag missing — was it removed by the agent?",
      );
    }
  }

  let insertions = 0;
  let deletions = 0;
  let filesChanged = 0;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [add, del] = line.split("\t").map(Number);
    if (!isNaN(add) && !isNaN(del)) {
      insertions += add;
      deletions += del;
      filesChanged++;
    }
  }

  return { patch, filesChanged, insertions, deletions };
}
