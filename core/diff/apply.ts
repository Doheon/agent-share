/**
 * Git patch 적용 모듈
 * git apply --check 로 먼저 검증 후 적용
 */

import { join } from "@std/path";

async function runGit(
  args: string[],
  cwd: string,
  stdin?: string,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    stdin: stdin !== undefined ? "piped" : "null",
  });

  if (stdin !== undefined) {
    const process = cmd.spawn();
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
    const { success, stdout, stderr } = await process.output();
    return {
      success,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  }

  const { success, stdout, stderr } = await cmd.output();
  return {
    success,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

export interface ApplyResult {
  success: boolean;
  error?: string;
  conflicts?: string[];
}

/** patch를 적용하기 전 검증만 수행 */
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

/** patch 실제 적용 */
export async function applyPatch(patch: string, targetDir: string): Promise<ApplyResult> {
  // 먼저 검증
  const checkResult = await checkPatch(patch, targetDir);
  if (!checkResult.success) {
    return checkResult;
  }

  const { success, stderr } = await runGit(
    ["apply", "--whitespace=nowarn", "-"],
    targetDir,
    patch,
  );

  if (!success) {
    return { success: false, error: stderr };
  }

  return { success: true };
}

/** patch 파일을 읽어서 적용 */
export async function applyPatchFile(
  patchPath: string,
  targetDir: string,
): Promise<ApplyResult> {
  const patch = await Deno.readTextFile(patchPath);
  return await applyPatch(patch, targetDir);
}

/** 변경된 파일 목록 추출 */
export function getChangedFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split("\n")) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (match) files.push(match[1]);
  }
  return files;
}

/** patch 요약 출력 (리뷰용) */
export function summarizePatch(patch: string): string {
  const files = getChangedFiles(patch);
  const additions = (patch.match(/^\+[^+]/gm) ?? []).length;
  const deletions = (patch.match(/^-[^-]/gm) ?? []).length;

  return [
    `변경된 파일 ${files.length}개:`,
    ...files.map((f) => `  • ${f}`),
    ``,
    `+${additions} 줄 추가 / -${deletions} 줄 삭제`,
  ].join("\n");
}
