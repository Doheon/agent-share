/**
 * Git diff 추출 모듈
 * git add -A && git diff HEAD 로 신규 파일 포함 전체 변경사항 캡처
 */

import type { DiffResult } from "../../shared/types.ts";

async function runGit(args: string[], cwd: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stdout, stderr } = await cmd.output();
  return {
    success,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

/** 작업 디렉토리를 git repo로 초기화하고 초기 커밋 생성 */
export async function initRepo(workDir: string): Promise<void> {
  await runGit(["init"], workDir);
  await runGit(["config", "user.email", "sandbox@agent-share"], workDir);
  await runGit(["config", "user.name", "Sandbox"], workDir);
  await runGit(["add", "-A"], workDir);
  const { success, stderr } = await runGit(
    ["commit", "-m", "initial snapshot"],
    workDir,
  );
  if (!success) {
    throw new Error(`초기 커밋 실패: ${stderr}`);
  }
}

/** 에이전트 실행 후 변경사항을 diff로 추출 */
export async function extractDiff(workDir: string): Promise<DiffResult> {
  // 신규 파일 포함 스테이징
  await runGit(["add", "-A"], workDir);

  // unified diff 추출
  const { stdout: patch } = await runGit(
    ["diff", "--cached", "--unified=3"],
    workDir,
  );

  // 통계 추출
  const { stdout: stat } = await runGit(
    ["diff", "--cached", "--stat"],
    workDir,
  );

  const filesChanged = (stat.match(/\d+ file/g) ?? []).length;
  const insertions = parseInt(stat.match(/(\d+) insertion/)?.[1] ?? "0");
  const deletions = parseInt(stat.match(/(\d+) deletion/)?.[1] ?? "0");

  return { patch, filesChanged, insertions, deletions };
}
