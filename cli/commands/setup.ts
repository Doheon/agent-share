/**
 * agent-share setup [--daemon]
 * 환경 설정 및 체크를 수행합니다.
 */

import { Command } from "cliffy/command";
import { join } from "@std/path";
import { getClient, getCurrentUserId } from "../client.ts";
import { hasKeyPair, createKeyPair } from "../../core/crypto/keypair.ts";
import { exportPublicKeyPem } from "../../core/crypto/rsa.ts";
import { imageExists, buildImage } from "../../core/sandbox/image.ts";

const HOME = Deno.env.get("HOME") ?? "~";
const AGENT_SHARE_DIR = join(HOME, ".agent-share");

// ─── 체크 헬퍼 ────────────────────────────────────────────────────────────────

async function runCommand(cmd: string, args: string[]): Promise<{ success: boolean; output: string }> {
  try {
    const proc = new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const { success, stdout, stderr } = await proc.output();
    const output = new TextDecoder().decode(success ? stdout : stderr).trim();
    return { success, output };
  } catch {
    return { success: false, output: "실행 파일을 찾을 수 없습니다" };
  }
}

function ok(label: string, detail = ""): void {
  console.log(`  ✅ ${label}${detail ? `  (${detail})` : ""}`);
}

function fail(label: string, hint = ""): void {
  console.log(`  ❌ ${label}${hint ? `\n     → ${hint}` : ""}`);
}

function warn(label: string, hint = ""): void {
  console.log(`  ⚠️  ${label}${hint ? `\n     → ${hint}` : ""}`);
}

// ─── OS 감지 ─────────────────────────────────────────────────────────────────

function isMacOS(): boolean {
  return Deno.build.os === "darwin";
}

function isLinux(): boolean {
  return Deno.build.os === "linux";
}

// ─── 자동 시작 등록 ──────────────────────────────────────────────────────────

async function registerLaunchAgent(): Promise<void> {
  const plistDir = join(HOME, "Library", "LaunchAgents");
  const plistPath = join(plistDir, "sh.agent-share.daemon.plist");
  const selfPath = Deno.execPath();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.agent-share.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${selfPath}</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${AGENT_SHARE_DIR}/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${AGENT_SHARE_DIR}/daemon.log</string>
</dict>
</plist>`;

  await Deno.mkdir(plistDir, { recursive: true });
  await Deno.writeTextFile(plistPath, plist);

  const { success } = await runCommand("launchctl", ["load", plistPath]);
  if (success) {
    console.log(`\n✅ macOS LaunchAgent 등록 완료: ${plistPath}`);
  } else {
    console.log(`\n⚠️  LaunchAgent 파일 생성 완료: ${plistPath}`);
    console.log(`   수동으로 로드하려면: launchctl load ${plistPath}`);
  }
}

async function registerSystemdUnit(): Promise<void> {
  const systemdDir = join(HOME, ".config", "systemd", "user");
  const unitPath = join(systemdDir, "agent-share.service");
  const selfPath = Deno.execPath();

  const unit = `[Unit]
Description=agent-share daemon
After=network.target

[Service]
Type=simple
ExecStart=${selfPath} daemon start
Restart=on-failure
StandardOutput=append:${AGENT_SHARE_DIR}/daemon.log
StandardError=append:${AGENT_SHARE_DIR}/daemon.log

[Install]
WantedBy=default.target
`;

  await Deno.mkdir(systemdDir, { recursive: true });
  await Deno.writeTextFile(unitPath, unit);

  await runCommand("systemctl", ["--user", "daemon-reload"]);
  const { success } = await runCommand("systemctl", ["--user", "enable", "agent-share.service"]);

  if (success) {
    console.log(`\n✅ systemd 유닛 등록 완료: ${unitPath}`);
    console.log(`   시작: systemctl --user start agent-share.service`);
  } else {
    console.log(`\n⚠️  systemd 유닛 파일 생성 완료: ${unitPath}`);
    console.log(`   수동으로 활성화: systemctl --user enable agent-share.service`);
  }
}

// ─── 메인 setup 로직 ─────────────────────────────────────────────────────────

async function runSetup(daemon: boolean): Promise<void> {
  console.log("\n🔧 agent-share 환경 설정 확인 중...\n");
  let allOk = true;

  // 1. git 버전 확인
  const git = await runCommand("git", ["--version"]);
  if (git.success) {
    ok("git", git.output);
  } else {
    fail("git 미설치", "https://git-scm.com/downloads 에서 설치하세요");
    allOk = false;
  }

  // 2. podman 버전 확인
  const podman = await runCommand("podman", ["--version"]);
  if (podman.success) {
    ok("podman", podman.output);

    // rootless 여부 확인
    const info = await runCommand("podman", ["info", "--format", "{{.Host.Security.Rootless}}"]);
    if (info.success && info.output.trim() === "true") {
      ok("podman rootless 모드");
    } else {
      warn("podman rootless 미확인", "rootless 모드를 권장합니다");
    }

    // macOS: podman machine 실행 여부
    if (isMacOS()) {
      const machine = await runCommand("podman", ["machine", "list", "--format", "{{.Running}}"]);
      if (machine.success && machine.output.includes("true")) {
        ok("podman machine 실행 중");
      } else {
        fail("podman machine 미실행", "podman machine start 를 실행하세요");
        allOk = false;
      }
    }
  } else {
    fail("podman 미설치", "https://podman.io/getting-started/installation 에서 설치하세요");
    allOk = false;
  }

  // 3. agent-share-sandbox 이미지 확인
  if (podman.success) {
    const imgExists = await imageExists();
    if (imgExists) {
      ok("agent-share-sandbox 이미지");
    } else {
      console.log("  🔨 agent-share-sandbox 이미지 빌드 중...");
      try {
        await buildImage();
        ok("agent-share-sandbox 이미지 빌드 완료");
      } catch (err) {
        fail("이미지 빌드 실패", (err as Error).message);
        allOk = false;
      }
    }
  }

  // 4. ~/.agent-share/ 디렉토리 쓰기 가능 여부
  try {
    await Deno.mkdir(AGENT_SHARE_DIR, { recursive: true });
    const testFile = join(AGENT_SHARE_DIR, ".write-test");
    await Deno.writeTextFile(testFile, "test");
    await Deno.remove(testFile);
    ok(`${AGENT_SHARE_DIR} 디렉토리 쓰기 가능`);
  } catch {
    fail(`${AGENT_SHARE_DIR} 디렉토리 쓰기 불가`);
    allOk = false;
  }

  // 5. RSA 키쌍 확인 / 생성
  let userId: string | null = null;
  try {
    const client = await getClient();
    const { data: { user } } = await client.auth.getUser();
    userId = user?.id ?? null;
  } catch { /* 로그인 안 된 경우 */ }

  if (userId) {
    if (await hasKeyPair(userId)) {
      ok("RSA 키쌍 존재");
    } else {
      console.log("  🔑 RSA 키쌍 생성 중...");
      try {
        const pair = await createKeyPair(userId);
        const pubPem = await exportPublicKeyPem(pair.publicKey);
        ok("RSA 키쌍 생성 완료");

        // Supabase에 공개키 등록
        const client = await getClient();
        const { error } = await client
          .from("users")
          .upsert({ id: userId, public_key: pubPem, created_at: new Date().toISOString() });

        if (error) {
          warn("공개키 DB 등록 실패", error.message);
        } else {
          ok("공개키 Supabase 등록 완료");
        }
      } catch (err) {
        fail("RSA 키쌍 생성 실패", (err as Error).message);
        allOk = false;
      }
    }
  } else {
    warn("로그인 안 됨 - RSA 키 확인 건너뜀", "agent-share login 을 먼저 실행하세요");
  }

  // 6. Supabase 연결 확인
  try {
    const client = await getClient();
    const { error } = await client.from("tasks").select("id").limit(1);
    if (error) {
      fail("Supabase 연결 실패", error.message);
      allOk = false;
    } else {
      ok("Supabase 연결 정상");
    }
  } catch (err) {
    fail("Supabase 연결 실패", (err as Error).message);
    allOk = false;
  }

  console.log();

  if (allOk) {
    console.log("✅ 모든 환경 설정이 완료되었습니다.\n");
  } else {
    console.log("⚠️  일부 항목을 확인해주세요.\n");
  }

  // --daemon 플래그: OS 자동시작 등록
  if (daemon) {
    console.log("🚀 OS 자동시작 등록 중...");
    if (isMacOS()) {
      await registerLaunchAgent();
    } else if (isLinux()) {
      await registerSystemdUnit();
    } else {
      console.log("⚠️  현재 OS는 자동시작 등록을 지원하지 않습니다.");
    }
  }
}

export const setupCommand = new Command()
  .name("setup")
  .description("환경 설정 및 의존성을 확인합니다")
  .option("--daemon", "OS 자동시작(LaunchAgent/systemd)에 데몬을 등록합니다")
  .action(async (options) => {
    try {
      await runSetup(options.daemon ?? false);
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });
