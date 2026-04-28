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
}

export async function extractDiff(workDir: string): Promise<DiffResult> {
  await runGit(["add", "-A"], workDir);

  const { stdout: patch }   = await runGit(["diff", "--cached", "--unified=3"], workDir);
  const { stdout: numstat } = await runGit(["diff", "--cached", "--numstat"], workDir);

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
