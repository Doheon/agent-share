import { readFile } from "node:fs/promises";
import { spawn } from "../util/spawn.ts";

async function runGit(
  args: string[],
  cwd: string,
  stdin?: string,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const proc = spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin,
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, proc.stdout, proc.stderr]);
  return { success: exitCode === 0, stdout, stderr };
}

export interface ApplyResult {
  success: boolean;
  error?: string;
  conflicts?: string[];
}

export async function checkPatch(patch: string, targetDir: string): Promise<ApplyResult> {
  const { success, stderr } = await runGit(
    ["apply", "--check", "--whitespace=nowarn", "-"],
    targetDir,
    patch,
  );
  if (!success) {
    const conflicts = stderr
      .split("\n")
      .filter((l) => l.includes("error:"))
      .map((l) => l.replace("error:", "").trim());
    return { success: false, error: stderr, conflicts };
  }
  return { success: true };
}

export async function applyPatch(patch: string, targetDir: string): Promise<ApplyResult> {
  const checkResult = await checkPatch(patch, targetDir);
  if (!checkResult.success) return checkResult;

  const { success, stderr } = await runGit(
    ["apply", "--whitespace=nowarn", "-"],
    targetDir,
    patch,
  );
  if (!success) return { success: false, error: stderr };
  return { success: true };
}

export async function applyPatchFile(patchPath: string, targetDir: string): Promise<ApplyResult> {
  const patch = await readFile(patchPath, "utf-8");
  return await applyPatch(patch, targetDir);
}

export function getChangedFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split("\n")) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (match) files.push(match[1]!);
  }
  return files;
}

export function summarizePatch(patch: string): string {
  const files      = getChangedFiles(patch);
  const additions  = (patch.match(/^\+(?!\+\+)/gm) ?? []).length;
  const deletions  = (patch.match(/^-(?!--)/gm) ?? []).length;
  return [
    `${files.length} file(s) changed:`,
    ...files.map((f) => `  - ${f}`),
    ``,
    `+${additions} line(s) added / -${deletions} line(s) removed`,
  ].join("\n");
}
