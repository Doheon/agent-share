/**
 * agent-share submit <dir> [options]
 * 디렉토리를 암호화하여 Supabase에 업로드하고 작업을 등록합니다.
 */

import { Command } from "cliffy/command";
import { getClient, getCurrentUserId } from "../client.ts";
import { scanDirectory, formatScanResults } from "../../core/packaging/secret_scanner.ts";
import { packDirectory } from "../../core/packaging/pack.ts";
import { loadPublicKeyPem } from "../../core/crypto/keypair.ts";
import { importPublicKeyPem, encryptAesKey } from "../../core/crypto/rsa.ts";

interface SubmitOptions {
  prompt: string;
  credits: number;
  agentHost: string | string[];
  watch?: boolean;
}

async function runSubmit(dir: string, options: SubmitOptions): Promise<void> {
  const client = await getClient();
  const userId = await getCurrentUserId();

  // 절대경로 변환
  const absDir = dir.startsWith("/") ? dir : `${Deno.cwd()}/${dir}`;

  // 디렉토리 존재 확인
  try {
    const stat = await Deno.stat(absDir);
    if (!stat.isDirectory) {
      throw new Error(`경로가 디렉토리가 아닙니다: ${absDir}`);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`디렉토리를 찾을 수 없습니다: ${absDir}`);
    }
    throw err;
  }

  // 1. 민감 정보 스캔
  console.log("🔍 민감 정보 스캔 중...");
  const scanResults = await scanDirectory(absDir);
  if (scanResults.length > 0) {
    console.error(formatScanResults(scanResults));
    Deno.exit(1);
  }
  console.log("✅ 민감 정보 없음");

  // 2. 디렉토리 패킹 (암호화 tar)
  console.log("📦 디렉토리 패킹 중...");
  const { ciphertext, iv, aesKeyRaw } = await packDirectory(absDir);

  // iv + ciphertext 합치기 (accept.ts와 동일한 형식)
  const blob = new Uint8Array(iv.length + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, iv.length);

  // 3. Supabase Storage 'blobs' 버킷에 업로드
  console.log("☁️  Supabase Storage에 업로드 중...");
  const blobId = crypto.randomUUID();
  const blobPath = `${userId}/${blobId}.enc`;

  const { error: uploadErr } = await client.storage
    .from("blobs")
    .upload(blobPath, blob, {
      contentType: "application/octet-stream",
      upsert: false,
    });

  if (uploadErr) throw new Error(`blob 업로드 실패: ${uploadErr.message}`);

  const { data: { publicUrl } } = client.storage
    .from("blobs")
    .getPublicUrl(blobPath);

  // 4. 현재 사용자 공개키로 AES 키 암호화
  console.log("🔐 AES 키 암호화 중...");
  const publicKeyPem = await loadPublicKeyPem(userId);
  const publicKey = await importPublicKeyPem(publicKeyPem);
  const encryptedAesKey = await encryptAesKey(aesKeyRaw, publicKey);

  // 5. 허용 호스트 목록 구성
  const defaultHosts = ["api.anthropic.com"];
  const extraHosts = Array.isArray(options.agentHost)
    ? options.agentHost
    : options.agentHost
    ? [options.agentHost]
    : [];
  const allowedHosts = [...new Set([...defaultHosts, ...extraHosts])];

  // 6. tasks 테이블에 INSERT
  console.log("📋 작업 등록 중...");
  const { data: task, error: insertErr } = await client
    .from("tasks")
    .insert({
      requester_id: userId,
      status: "pending",
      encrypted_blob_url: publicUrl,
      encrypted_aes_key: encryptedAesKey,
      credit_amount: options.credits,
      prompt: options.prompt,
      allowed_hosts: allowedHosts,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertErr || !task) {
    throw new Error(`작업 등록 실패: ${insertErr?.message ?? "알 수 없는 오류"}`);
  }

  console.log(`\n✅ 작업이 등록되었습니다. ID: ${task.id}`);
  console.log(`   크레딧: ${options.credits}`);
  console.log(`   허용 호스트: ${allowedHosts.join(", ")}`);

  // 7. Realtime diff 수신 대기 (--watch 옵션)
  if (options.watch) {
    console.log("\n👀 diff 수신 대기 중... (Ctrl+C 로 중단)");

    const channel = client
      .channel(`user:${userId}:notifications`)
      .on("broadcast", { event: "diff_ready" }, (payload) => {
        const p = payload.payload as {
          taskId: string;
          filesChanged: number;
          insertions: number;
          deletions: number;
        };
        if (p.taskId === task.id) {
          console.log(`\n📊 diff 수신 완료!`);
          console.log(`   파일 변경: ${p.filesChanged}개`);
          console.log(`   +${p.insertions} / -${p.deletions}`);
          console.log(`\n ash review ${task.id} 로 내용을 확인하세요.`);
          Deno.exit(0);
        }
      })
      .subscribe();

    // 종료 시 채널 해제
    const cleanup = () => {
      channel.unsubscribe();
      Deno.exit(0);
    };
    Deno.addSignalListener("SIGINT", cleanup);
    Deno.addSignalListener("SIGTERM", cleanup);

    // 무한 대기
    await new Promise<void>(() => {});
  }
}

export const submitCommand = new Command()
  .name("submit")
  .description("디렉토리를 암호화하여 작업을 등록합니다")
  .arguments("<dir:string>")
  .option("--prompt <text:string>", "작업 설명 (필수)", { required: true })
  .option("--credits <n:number>", "제시 크레딧", { default: 10 })
  .option(
    "--agent-host <host:string>",
    "허용 호스트 추가 (반복 가능, 기본: api.anthropic.com)",
    { collect: true },
  )
  .option("--watch", "diff 수신 완료까지 대기")
  .action(async (options, dir: string) => {
    try {
      await runSubmit(dir, {
        prompt: options.prompt,
        credits: options.credits,
        agentHost: options.agentHost ?? [],
        watch: options.watch,
      });
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });
