/**
 * agent-share accept <task_id>
 * 작업 수락 및 자동 실행 전체 플로우:
 * 1. task 메타데이터 조회
 * 2. encrypted blob 다운로드 + 복호화 + 언팩
 * 3. git init (diff 기준점)
 * 4. Podman 샌드박스에서 에이전트 실행
 * 5. git diff 추출 → Supabase 업로드
 * 6. 요청자 알림
 * 7. 정리
 */

import { Command } from "cliffy/command";
import { getClient, getCurrentUserId } from "../client.ts";
import { loadPrivateKey } from "../../core/crypto/keypair.ts";
import { decryptAesKey } from "../../core/crypto/rsa.ts";

import { unpackToDirectory } from "../../core/packaging/unpack.ts";
import { runAgentInSandbox } from "../../core/sandbox/runner.ts";
import { initRepo, extractDiff } from "../../core/diff/extract.ts";
import { cleanupTask, ensureTaskDir } from "../../core/sandbox/cleanup.ts";
import type { Task } from "../../shared/types.ts";

interface AcceptOptions {
  agent?: string;
  apiKey?: string;
}

async function downloadBlob(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`blob 다운로드 실패: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function runAccept(taskId: string, options: AcceptOptions): Promise<void> {
  const client = await getClient();
  const userId = await getCurrentUserId();

  console.log(`\n📋 작업 정보를 가져오는 중...`);

  // 1. task 조회 및 수락 처리
  const { data: task, error: taskErr } = await client
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (taskErr || !task) {
    throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
  }

  const t = task as Task;

  if (t.status !== "open") {
    throw new Error(`수락할 수 없는 작업 상태입니다: ${t.status}`);
  }

  if (t.requester_id === userId) {
    throw new Error("자신의 작업은 수락할 수 없습니다.");
  }

  // 에스크로 + 매칭 (Edge Function 호출)
  console.log(`💰 에스크로 처리 중...`);
  const { error: escrowErr } = await client.functions.invoke("match-task", {
    body: { taskId, acceptorId: userId },
  });
  if (escrowErr) throw new Error(`에스크로 처리 실패: ${escrowErr.message}`);

  // 최신 task 재조회
  const { data: updatedTask } = await client
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .single();
  const currentTask = updatedTask as Task;

  // 2. 암호화된 blob 다운로드
  console.log(`📥 코드 다운로드 중...`);
  if (!currentTask.encrypted_blob_url || !currentTask.encrypted_aes_key) {
    throw new Error("암호화된 코드 정보가 없습니다.");
  }

  const ciphertext = await downloadBlob(currentTask.encrypted_blob_url);

  // 3. AES 키 복호화
  const privateKey = await loadPrivateKey(userId);
  const aesKeyRaw = await decryptAesKey(currentTask.encrypted_aes_key, privateKey);

  // iv는 ciphertext 앞 12바이트로 저장
  const iv = ciphertext.slice(0, 12);
  const actualCiphertext = ciphertext.slice(12);

  // 4. 임시 작업 폴더에 언팩
  console.log(`📦 코드 복호화 중...`);
  const workDir = await ensureTaskDir(taskId);
  await unpackToDirectory(actualCiphertext, aesKeyRaw, iv, workDir);

  // 5. git 초기 스냅샷
  console.log(`🔧 작업 환경 초기화 중...`);
  await initRepo(workDir);

  // 6. Podman 샌드박스에서 에이전트 실행
  const agentCmd = options.agent ?? "claude";
  const apiKey = options.apiKey ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";

  if (!apiKey) {
    throw new Error(
      `API 키가 필요합니다. --api-key 옵션 또는 ANTHROPIC_API_KEY 환경변수를 설정해주세요.`,
    );
  }

  console.log(`\n🤖 에이전트 실행 중 (${agentCmd})...`);
  console.log(`📝 작업: ${currentTask.prompt}\n`);
  console.log("─".repeat(60));

  // Realtime 채널 구독 (로그 발행)
  const channel = client.channel(`task:${taskId}:logs`);
  await channel.subscribe();

  const { exitCode } = await runAgentInSandbox({
    taskDir: workDir,
    agentCmd,
    prompt: currentTask.prompt,
    allowedHosts: currentTask.allowed_hosts,
    apiKey,
    onLog: (line) => {
      console.log(line);
      channel.send({
        type: "broadcast",
        event: "log",
        payload: { line, timestamp: new Date().toISOString() },
      });
    },
  });

  console.log("─".repeat(60));
  console.log(`\n✅ 에이전트 완료 (exit code: ${exitCode})`);

  // 7. diff 추출
  console.log(`📊 변경사항 추출 중...`);
  const diff = await extractDiff(workDir);

  if (!diff.patch) {
    console.log("⚠️  변경사항이 없습니다. 작업을 취소합니다.");
    await cleanupTask(taskId);
    return;
  }

  console.log(`  ${diff.filesChanged}개 파일 변경 (+${diff.insertions}/-${diff.deletions})`);

  // 8. diff 업로드
  const { data: uploadData, error: uploadErr } = await client.storage
    .from("diffs")
    .upload(`${taskId}/result.patch`, new TextEncoder().encode(diff.patch), {
      contentType: "text/plain",
      upsert: true,
    });

  if (uploadErr) throw new Error(`diff 업로드 실패: ${uploadErr.message}`);

  const { data: { publicUrl } } = client.storage
    .from("diffs")
    .getPublicUrl(`${taskId}/result.patch`);

  // 9. task 상태 업데이트
  await client
    .from("tasks")
    .update({
      status: "review",
      diff_result: publicUrl,
      diff_received_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId);

  // 10. 요청자에게 Realtime 알림
  await client.channel(`user:${currentTask.requester_id}:notifications`).send({
    type: "broadcast",
    event: "diff_ready",
    payload: {
      taskId,
      filesChanged: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
    },
  });

  console.log(`\n✅ 완료! 요청자가 diff를 리뷰 중입니다.`);
  console.log(`   작업 ID: ${taskId}`);

  // 11. 정리
  await cleanupTask(taskId);
  await channel.unsubscribe();
}

export const acceptCommand = new Command()
  .name("accept")
  .description("작업을 수락하고 AI 에이전트로 자동 실행합니다")
  .arguments("<task_id:string>")
  .option("--agent <agent:string>", "사용할 에이전트 (기본: claude)", {
    default: "claude",
  })
  .option("--api-key <key:string>", "에이전트 API 키 (기본: ANTHROPIC_API_KEY 환경변수)")
  .action(async (options, taskId: string) => {
    try {
      await runAccept(taskId, options);
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });
