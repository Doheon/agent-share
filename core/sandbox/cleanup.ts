import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { spawn } from "../util/spawn.ts";

const TASK_BASE_DIR = join(process.env.TMPDIR ?? "/tmp", "agent-share");

export function taskDir(taskId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    throw new Error(`Invalid taskId: ${taskId}`);
  }
  return join(TASK_BASE_DIR, taskId);
}

export async function cleanupTask(taskId: string): Promise<void> {
  const dir = taskDir(taskId);

  try {
    await rm(dir, { recursive: true, force: true });
  } catch { /* already removed */ }

  try {
    const { getRuntime } = await import("./runtime.ts");
    const runtime = await getRuntime();
    const proc = spawn([runtime, "rm", "-f", `agent-share-${taskId}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch { /* container not found */ }
}

export async function ensureTaskDir(taskId: string): Promise<string> {
  const dir = taskDir(taskId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch { /* didn't exist */ }
  await mkdir(dir, { recursive: true });
  return dir;
}
