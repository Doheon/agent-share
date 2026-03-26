/**
 * Podman rootless 컨테이너 실행 래퍼
 * 수락자의 AI 에이전트를 완전 격리된 환경에서 실행
 */

import { FULL_IMAGE, ensureImage } from "./image.ts";
import type { RunResult } from "../../shared/types.ts";

export interface SandboxOptions {
  taskDir: string;         // 호스트의 작업 폴더 (/workspace로 마운트)
  agentCmd: string;        // e.g., "claude"
  agentArgs?: string[];    // 추가 인자
  prompt: string;
  allowedHosts: string[];  // e.g., ["api.anthropic.com"]
  apiKey: string;          // 수락자 에이전트 API 키
  onLog?: (line: string) => void; // 실시간 로그 콜백
  timeoutMs?: number;      // 기본 25분 (30분 타임아웃 전 여유)
}

export async function runAgentInSandbox(opts: SandboxOptions): Promise<RunResult> {
  const {
    taskDir,
    agentCmd,
    agentArgs = [],
    prompt,
    allowedHosts,
    apiKey,
    onLog,
    timeoutMs = 25 * 60 * 1000,
  } = opts;

  await ensureImage();

  // 네트워크 화이트리스트 구성
  const networkMode = allowedHosts.length > 0
    ? `slirp4netns:allow_host_loopback=false`
    : "none";

  const args: string[] = [
    "run",
    "--rm",
    `--network=${networkMode}`,
    `--volume=${taskDir}:/workspace:z`,
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=100m",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--env-host=false",
    "--env", `ANTHROPIC_API_KEY=${apiKey}`,
    "--env", `OPENAI_API_KEY=${apiKey}`,
    "--env", `AGENT_PROMPT=${prompt}`,
    "--workdir", "/workspace",
    FULL_IMAGE,
    agentCmd,
    "-p", prompt,
    ...agentArgs,
  ];

  const cmd = new Deno.Command("podman", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const process = cmd.spawn();

  const stdout: string[] = [];
  const stderr: string[] = [];

  // stdout 스트리밍
  const stdoutReader = process.stdout.getReader();
  const stderrReader = process.stderr.getReader();
  const dec = new TextDecoder();

  const readStream = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    buffer: string[],
  ) => {
    let partial = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = partial + dec.decode(value, { stream: true });
      const lines = chunk.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        buffer.push(line);
        onLog?.(line);
      }
    }
    if (partial) {
      buffer.push(partial);
      onLog?.(partial);
    }
  };

  // 타임아웃 설정
  const timeout = setTimeout(async () => {
    try {
      await new Deno.Command("podman", {
        args: ["kill", "--signal", "SIGKILL"],
        stdout: "null",
        stderr: "null",
      }).output();
    } catch { /* 이미 종료됨 */ }
  }, timeoutMs);

  try {
    await Promise.all([
      readStream(stdoutReader, stdout),
      readStream(stderrReader, stderr),
    ]);

    const { code } = await process.status;
    return {
      exitCode: code,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    clearTimeout(timeout);
  }
}
