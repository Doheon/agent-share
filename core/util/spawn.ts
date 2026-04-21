/**
 * Thin Node child_process wrapper providing a Bun.spawn-like surface area.
 *
 * Supported stdio modes (per stream):
 *   - "pipe"    buffered, joined result promised via `.stdout` / `.stderr`
 *   - "inherit" pass through to parent
 *   - "ignore"  /dev/null
 * For stdin: "inherit" | string (written on launch) | undefined.
 *
 * An optional `onLine(stream, line)` callback is invoked for each complete
 * line on piped stdout/stderr while still contributing to the buffered result.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export type StdioMode = "pipe" | "inherit" | "ignore";

export interface SpawnOptions {
  stdout?: StdioMode;
  stderr?: StdioMode;
  /** stdin: "inherit" | string to pipe | undefined (no stdin) */
  stdin?: "inherit" | string;
  cwd?: string;
  env?: Record<string, string>;
  /** Invoked for each complete line on piped stdout/stderr. */
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}

export interface SpawnResult {
  child: ChildProcess;
  exited: Promise<number>;
  stdout: Promise<string>;
  stderr: Promise<string>;
  kill: (signal?: NodeJS.Signals) => void;
}

function collect(
  stream: NodeJS.ReadableStream | null,
  onLine?: (line: string) => void,
): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise((resolve) => {
    let full = "";
    let partial = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      full += chunk;
      if (!onLine) return;
      const combined = partial + chunk;
      const lines = combined.split("\n");
      partial = lines.pop() ?? "";
      for (const l of lines) onLine(l);
    });
    const finish = () => {
      if (onLine && partial) onLine(partial);
      resolve(full);
    };
    stream.on("end", finish);
    stream.on("error", finish);
  });
}

export function spawn(cmd: string[], opts: SpawnOptions = {}): SpawnResult {
  const stdoutMode = opts.stdout ?? "inherit";
  const stderrMode = opts.stderr ?? "inherit";
  const stdinMode: "pipe" | "inherit" | "ignore" =
    opts.stdin === "inherit" ? "inherit" : typeof opts.stdin === "string" ? "pipe" : "ignore";

  const child = nodeSpawn(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: [stdinMode, stdoutMode, stderrMode],
  });

  if (stdinMode === "pipe" && typeof opts.stdin === "string" && child.stdin) {
    child.stdin.end(opts.stdin);
  }

  const stdoutP = stdoutMode === "pipe"
    ? collect(child.stdout, opts.onLine ? (l) => opts.onLine!("stdout", l) : undefined)
    : Promise.resolve("");
  const stderrP = stderrMode === "pipe"
    ? collect(child.stderr, opts.onLine ? (l) => opts.onLine!("stderr", l) : undefined)
    : Promise.resolve("");

  const exited: Promise<number> = new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

  return {
    child,
    exited,
    stdout: stdoutP,
    stderr: stderrP,
    kill: (signal?: NodeJS.Signals) => {
      try { child.kill(signal); } catch { /* already exited */ }
    },
  };
}
