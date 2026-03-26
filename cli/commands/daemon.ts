/**
 * agent-share daemon start/stop/status
 * Supabase Realtime으로 'pending' 작업을 감지하고 자동 수락합니다.
 */

import { Command } from "cliffy/command";
import { join } from "@std/path";
import { getClient, getCurrentUserId } from "../client.ts";
import type { Task, DaemonConfig } from "../../shared/types.ts";

const HOME = Deno.env.get("HOME") ?? "~";
const AGENT_SHARE_DIR = join(HOME, ".agent-share");
const PID_FILE = join(AGENT_SHARE_DIR, "daemon.pid");
const LOG_FILE = join(AGENT_SHARE_DIR, "daemon.log");

// ─── 스케줄 파싱 ──────────────────────────────────────────────────────────────

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseDayRange(range: string): number[] {
  const parts = range.toLowerCase().split("-");
  if (parts.length === 1) {
    const d = DAY_MAP[parts[0]];
    return d !== undefined ? [d] : [];
  }
  const start = DAY_MAP[parts[0]] ?? 0;
  const end = DAY_MAP[parts[1]] ?? 6;
  const days: number[] = [];
  for (let d = start; d <= end; d++) days.push(d);
  return days;
}

function parseTimeRange(range: string): { startMin: number; endMin: number } {
  const [startStr, endStr] = range.split("-");
  const toMin = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + (m ?? 0);
  };
  return { startMin: toMin(startStr), endMin: toMin(endStr) };
}

export function isWithinSchedule(schedule: string): boolean {
  if (!schedule || !schedule.trim()) return true;

  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 2) return true;

  const [dayPart, timePart] = parts;
  const allowedDays = parseDayRange(dayPart);
  const { startMin, endMin } = parseTimeRange(timePart);

  const now = new Date();
  const currentDay = now.getDay();
  const currentMin = now.getHours() * 60 + now.getMinutes();

  return allowedDays.includes(currentDay) &&
    currentMin >= startMin &&
    currentMin <= endMin;
}

// ─── 로그 헬퍼 ────────────────────────────────────────────────────────────────

async function appendLog(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    await Deno.writeTextFile(LOG_FILE, line, { append: true });
  } catch {
    // 로그 실패는 무시
  }
}

// ─── 데몬 메인 루프 ──────────────────────────────────────────────────────────

async function daemonLoop(config: DaemonConfig): Promise<void> {
  await appendLog("데몬 시작");

  const client = await getClient();
  const userId = await getCurrentUserId();

  let activeTasks = 0;

  const channel = client
    .channel("tasks:pending")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "tasks", filter: "status=eq.pending" },
      async (payload) => {
        const task = payload.new as Task;

        // 자신의 작업 무시
        if (task.requester_id === userId) return;

        // 스케줄 확인
        if (!isWithinSchedule(config.schedule)) {
          await appendLog(`스케줄 외 시간 - 작업 건너뜀: ${task.id}`);
          return;
        }

        // 동시 실행 제한
        if (activeTasks >= config.maxConcurrentTasks) {
          await appendLog(`최대 동시 실행 수 초과 - 작업 건너뜀: ${task.id}`);
          return;
        }

        activeTasks++;
        await appendLog(`작업 수락 시작: ${task.id}`);

        try {
          // accept 플로우 실행 (subprocess)
          const agent = config.allowedAgents[0] ?? "claude";
          const apiKey = config.apiKeys[agent] ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";

          const selfPath = Deno.execPath();
          const cmd = new Deno.Command(selfPath, {
            args: [
              "run",
              "--allow-all",
              new URL("../../main.ts", import.meta.url).pathname,
              "accept",
              task.id,
              "--agent", agent,
              "--api-key", apiKey,
            ],
            stdout: "piped",
            stderr: "piped",
          });

          const proc = await cmd.output();
          const out = new TextDecoder().decode(proc.stdout);
          const errOut = new TextDecoder().decode(proc.stderr);

          if (proc.success) {
            await appendLog(`작업 완료: ${task.id}\n${out}`);
          } else {
            await appendLog(`작업 실패: ${task.id}\n${errOut}`);
          }
        } catch (err) {
          await appendLog(`작업 오류: ${task.id} - ${(err as Error).message}`);
        } finally {
          activeTasks--;
        }
      },
    )
    .subscribe();

  await appendLog("Realtime 구독 완료 - 작업 대기 중");

  // 종료 처리
  const cleanup = async () => {
    await appendLog("데몬 종료");
    await channel.unsubscribe();
    try {
      await Deno.remove(PID_FILE);
    } catch { /* 없으면 무시 */ }
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", cleanup);
  Deno.addSignalListener("SIGTERM", cleanup);

  // 무한 대기
  await new Promise<void>(() => {});
}

// ─── start/stop/status ───────────────────────────────────────────────────────

async function startDaemon(options: {
  schedule: string;
  maxTasks: number;
  agent: string;
  apiKey?: string;
}): Promise<void> {
  // 이미 실행 중인지 확인
  try {
    const pidStr = await Deno.readTextFile(PID_FILE);
    const pid = parseInt(pidStr.trim(), 10);
    // 프로세스 존재 확인
    try {
      Deno.kill(pid, "SIGCONT");
      console.error(`❌ 데몬이 이미 실행 중입니다. (PID: ${pid})`);
      Deno.exit(1);
    } catch {
      // PID 파일이 남아있지만 프로세스 없음 → 계속 진행
      await Deno.remove(PID_FILE).catch(() => {});
    }
  } catch { /* PID 파일 없음 → 정상 */ }

  await Deno.mkdir(AGENT_SHARE_DIR, { recursive: true });

  const config: DaemonConfig = {
    schedule: options.schedule,
    maxConcurrentTasks: options.maxTasks,
    allowedAgents: [options.agent],
    apiKeys: options.apiKey ? { [options.agent]: options.apiKey } : {},
  };

  // 백그라운드로 데몬 실행
  const selfPath = Deno.execPath();
  const proc = new Deno.Command(selfPath, {
    args: [
      "run",
      "--allow-all",
      new URL("../../main.ts", import.meta.url).pathname,
      "_daemon-run",
      JSON.stringify(config),
    ],
    stdout: "null",
    stderr: "null",
    stdin: "null",
  }).spawn();

  // PID 저장
  await Deno.writeTextFile(PID_FILE, proc.pid.toString(), { mode: 0o600 });

  console.log(`✅ 데몬을 시작했습니다. (PID: ${proc.pid})`);
  console.log(`   로그: ${LOG_FILE}`);
  if (options.schedule) {
    console.log(`   스케줄: ${options.schedule}`);
  }
}

async function stopDaemon(): Promise<void> {
  let pidStr: string;
  try {
    pidStr = await Deno.readTextFile(PID_FILE);
  } catch {
    console.error("❌ 실행 중인 데몬이 없습니다.");
    Deno.exit(1);
  }

  const pid = parseInt(pidStr.trim(), 10);
  try {
    Deno.kill(pid, "SIGTERM");
    await Deno.remove(PID_FILE).catch(() => {});
    console.log(`✅ 데몬을 중지했습니다. (PID: ${pid})`);
  } catch {
    console.error(`❌ 프로세스 종료 실패. PID: ${pid}`);
    await Deno.remove(PID_FILE).catch(() => {});
    Deno.exit(1);
  }
}

async function statusDaemon(): Promise<void> {
  let pidStr: string;
  try {
    pidStr = await Deno.readTextFile(PID_FILE);
  } catch {
    console.log("● 데몬: 중지됨");
    return;
  }

  const pid = parseInt(pidStr.trim(), 10);
  try {
    Deno.kill(pid, "SIGCONT");
    console.log(`● 데몬: 실행 중 (PID: ${pid})`);
    console.log(`  로그 파일: ${LOG_FILE}`);
    // 최근 로그 5줄 출력
    try {
      const log = await Deno.readTextFile(LOG_FILE);
      const lines = log.trim().split("\n").slice(-5);
      if (lines.length > 0) {
        console.log("\n최근 로그:");
        for (const line of lines) console.log(`  ${line}`);
      }
    } catch { /* 로그 없음 */ }
  } catch {
    console.log(`● 데몬: 중지됨 (오래된 PID 파일: ${pid})`);
    await Deno.remove(PID_FILE).catch(() => {});
  }
}

// ─── 커맨드 정의 ─────────────────────────────────────────────────────────────

const startCommand = new Command()
  .name("start")
  .description("데몬을 백그라운드에서 시작합니다")
  .option(
    "--schedule <schedule:string>",
    '실행 스케줄 (예: "mon-fri 09:00-18:00", 빈 값이면 항상 실행)',
    { default: "" },
  )
  .option("--max-tasks <n:number>", "최대 동시 실행 작업 수", { default: 3 })
  .option("--agent <agent:string>", "사용할 에이전트", { default: "claude" })
  .option("--api-key <key:string>", "에이전트 API 키")
  .action(async (options) => {
    try {
      await startDaemon({
        schedule: options.schedule,
        maxTasks: options.maxTasks,
        agent: options.agent,
        apiKey: options.apiKey,
      });
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });

const stopCommand = new Command()
  .name("stop")
  .description("실행 중인 데몬을 중지합니다")
  .action(async () => {
    try {
      await stopDaemon();
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });

const statusCommand = new Command()
  .name("status")
  .description("데몬 실행 상태를 확인합니다")
  .action(async () => {
    try {
      await statusDaemon();
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });

// 내부 커맨드: 실제 데몬 루프 실행 (백그라운드 프로세스에서 호출)
export const daemonRunCommand = new Command()
  .name("_daemon-run")
  .description("내부 데몬 루프 (직접 실행하지 마세요)")
  .arguments("<config_json:string>")
  .action(async (_options, configJson: string) => {
    try {
      const config = JSON.parse(configJson) as DaemonConfig;
      await daemonLoop(config);
    } catch (err) {
      await appendLog(`데몬 오류: ${(err as Error).message}`);
      Deno.exit(1);
    }
  });

export const daemonCommand = new Command()
  .name("daemon")
  .description("백그라운드 데몬을 관리합니다")
  .command("start", startCommand)
  .command("stop", stopCommand)
  .command("status", statusCommand);
