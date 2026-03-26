/**
 * 작업 종료 후 정리
 * - 임시 폴더 물리적 삭제
 * - 남은 컨테이너 제거
 */

import { join } from "@std/path";

const TASK_BASE_DIR = join(
  Deno.env.get("TMPDIR") ?? "/tmp",
  "agent-share",
);

export function taskDir(taskId: string): string {
  return join(TASK_BASE_DIR, taskId);
}

export async function cleanupTask(taskId: string): Promise<void> {
  const dir = taskDir(taskId);

  // 임시 폴더 삭제
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // 이미 삭제됐거나 없으면 무시
  }

  // 혹시 남은 컨테이너 제거
  try {
    await new Deno.Command("podman", {
      args: ["rm", "-f", `agent-share-${taskId}`],
      stdout: "null",
      stderr: "null",
    }).output();
  } catch { /* 없으면 무시 */ }
}

export async function ensureTaskDir(taskId: string): Promise<string> {
  const dir = taskDir(taskId);
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}
