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

/**
 * Reject patches that touch paths that should never be modified by a
 * remote acceptor's diff: `.git/` (could install hooks/config), absolute
 * paths (escape the repo), and parent traversals.
 *
 * `git apply` itself blocks these paths since 2.39 with `apply.useBuiltin`,
 * but pinning the user's git version is out of our control. Reject at
 * the wire boundary before invoking git.
 *
 * `getChangedFiles` only inspects `diff --git` headers, but git apply
 * also honors patches whose only header is `--- a/x\n+++ b/y` (no
 * `diff --git` line). Scan ALL plus/minus headers and strip CRLF /
 * trailing whitespace so attackers can't smuggle paths past the check
 * by appending `\r` (which git apply trims but our string check
 * preserves).
 */
function allHeaderPaths(patch: string): string[] {
  const out: string[] = [];
  for (const rawLine of patch.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trimEnd();
    let m;
    if ((m = line.match(/^diff --git a\/.+ b\/(.+)$/))) out.push(m[1]!);
    else if ((m = line.match(/^\+\+\+ b\/(.+?)(?:\t.*)?$/))) out.push(m[1]!);
    else if ((m = line.match(/^--- a\/(.+?)(?:\t.*)?$/))) out.push(m[1]!);
    // /dev/null on either side is normal for create/delete; skip.
    else if ((m = line.match(/^\+\+\+ (.+?)(?:\t.*)?$/)) && m[1] !== "/dev/null") out.push(m[1]!);
    else if ((m = line.match(/^--- (.+?)(?:\t.*)?$/)) && m[1] !== "/dev/null") out.push(m[1]!);
  }
  return out;
}

function unsafePathsIn(patch: string): string[] {
  const bad: string[] = [];
  for (const raw of allHeaderPaths(patch)) {
    const f = raw.replace(/\r/g, "").trim();
    if (
      !f ||
      f.startsWith(".git/") ||
      f.startsWith("/") ||
      f.includes("..") ||
      f.includes(".git/") ||
      // Embedded control chars (would let an attacker hide path
      // segments past a simple substring check).
      /[\x00-\x1f\x7f]/.test(f)
    ) {
      bad.push(f || "(empty)");
    }
  }
  return bad;
}

export async function checkPatch(patch: string, targetDir: string): Promise<ApplyResult> {
  const unsafe = unsafePathsIn(patch);
  if (unsafe.length > 0) {
    return {
      success: false,
      error: `patch rejected: unsafe paths\n  ${unsafe.join("\n  ")}`,
      conflicts: unsafe,
    };
  }
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
  const unsafe = unsafePathsIn(patch);
  if (unsafe.length > 0) {
    return {
      success: false,
      error: `patch rejected: unsafe paths\n  ${unsafe.join("\n  ")}`,
      conflicts: unsafe,
    };
  }
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
