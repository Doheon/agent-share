/**
 * agent-share review <task_id>  - diff 내용 출력
 * agent-share approve <task_id> - 작업 승인
 * agent-share reject <task_id>  - 작업 거절
 */

import { Command } from "cliffy/command";
import { getClient, getCurrentUserId } from "../client.ts";
import { summarizePatch } from "../../core/diff/apply.ts";
import type { Task } from "../../shared/types.ts";

async function downloadText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`diff 다운로드 실패: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

async function runReview(taskId: string): Promise<void> {
  const client = await getClient();
  await getCurrentUserId();

  const { data: task, error } = await client
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (error || !task) {
    throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
  }

  const t = task as Task;

  if (!t.diff_result) {
    throw new Error(
      `아직 diff가 없습니다. 상태: ${t.status}\n에이전트가 작업을 완료하면 diff가 생성됩니다.`,
    );
  }

  console.log(`\n📋 작업 ID: ${taskId}`);
  console.log(`   상태: ${t.status}`);
  console.log(`   프롬프트: ${t.prompt}`);
  console.log(`   크레딧: ${t.credit_amount}`);
  console.log(`   diff 수신: ${t.diff_received_at ?? "알 수 없음"}`);
  console.log("\n─".repeat(60));

  const patch = await downloadText(t.diff_result);

  if (!patch.trim()) {
    console.log("⚠️  변경사항이 없습니다.");
    return;
  }

  // 요약 출력
  console.log("\n📊 변경 요약:");
  console.log(summarizePatch(patch));

  // 전체 diff 출력
  console.log("\n" + "─".repeat(60));
  console.log("📄 전체 diff:\n");
  console.log(patch);
  console.log("─".repeat(60));
  console.log(`\n승인: ash approve ${taskId}`);
  console.log(`거절: ash reject ${taskId}`);
}

async function runApprove(taskId: string): Promise<void> {
  const client = await getClient();
  const userId = await getCurrentUserId();

  const { data: task, error } = await client
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (error || !task) {
    throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
  }

  const t = task as Task;

  if (t.requester_id !== userId) {
    throw new Error("자신의 작업만 승인/거절할 수 있습니다.");
  }

  if (t.status !== "review") {
    throw new Error(`승인할 수 없는 작업 상태입니다: ${t.status}`);
  }

  console.log("💰 크레딧 릴리즈 처리 중...");
  const { error: fnErr } = await client.functions.invoke("release-credit", {
    body: { taskId, action: "approve" },
  });

  if (fnErr) {
    throw new Error(`승인 처리 실패: ${fnErr.message}`);
  }

  console.log(`\n✅ 작업이 승인되었습니다.`);
  console.log(`   작업 ID: ${taskId}`);
  console.log(`   크레딧 ${t.credit_amount}개가 수락자에게 지급되었습니다.`);
}

async function runReject(taskId: string): Promise<void> {
  const client = await getClient();
  const userId = await getCurrentUserId();

  const { data: task, error } = await client
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (error || !task) {
    throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
  }

  const t = task as Task;

  if (t.requester_id !== userId) {
    throw new Error("자신의 작업만 승인/거절할 수 있습니다.");
  }

  if (t.status !== "review") {
    throw new Error(`거절할 수 없는 작업 상태입니다: ${t.status}`);
  }

  console.log("🔄 거절 처리 중...");
  const { error: fnErr } = await client.functions.invoke("release-credit", {
    body: { taskId, action: "reject" },
  });

  if (fnErr) {
    throw new Error(`거절 처리 실패: ${fnErr.message}`);
  }

  console.log(`\n✅ 작업이 거절되었습니다.`);
  console.log(`   작업 ID: ${taskId}`);
  console.log(`   크레딧 ${t.credit_amount}개가 환불되었습니다.`);
}

export const reviewCommand = new Command()
  .name("review")
  .description("작업 diff를 확인합니다")
  .arguments("<task_id:string>")
  .action(async (_options, taskId: string) => {
    try {
      await runReview(taskId);
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });

export const approveCommand = new Command()
  .name("approve")
  .description("작업을 승인하고 크레딧을 지급합니다")
  .arguments("<task_id:string>")
  .action(async (_options, taskId: string) => {
    try {
      await runApprove(taskId);
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });

export const rejectCommand = new Command()
  .name("reject")
  .description("작업을 거절하고 크레딧을 환불합니다")
  .arguments("<task_id:string>")
  .action(async (_options, taskId: string) => {
    try {
      await runReject(taskId);
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });
