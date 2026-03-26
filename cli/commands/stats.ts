/**
 * agent-share stats
 * 현재 사용자의 크레딧 통계를 출력합니다.
 */

import { Command } from "cliffy/command";
import { Table } from "cliffy/table";
import { getClient, getCurrentUserId } from "../client.ts";
import type { Transaction, UserBalance } from "../../shared/types.ts";

async function runStats(): Promise<void> {
  const client = await getClient();
  const userId = await getCurrentUserId();

  // 잔액 조회
  const { data: balanceData, error: balanceErr } = await client
    .from("user_balances")
    .select("*")
    .eq("id", userId)
    .single();

  if (balanceErr && balanceErr.code !== "PGRST116") {
    throw new Error(`잔액 조회 실패: ${balanceErr.message}`);
  }

  const balance = (balanceData as UserBalance | null)?.balance ?? 0;

  // 트랜잭션 조회 (수신 + 발신)
  const { data: txData, error: txErr } = await client
    .from("transactions")
    .select("*")
    .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);

  if (txErr) {
    throw new Error(`트랜잭션 조회 실패: ${txErr.message}`);
  }

  const txs = (txData ?? []) as Transaction[];

  // 통계 집계
  let totalEarned = 0;    // 기여(수락)로 받은 크레딧
  let totalSpent = 0;     // 요청(submit)에 사용된 크레딧
  let tasksCompleted = 0; // 완료한 작업 수 (수락자로서)

  for (const tx of txs) {
    if (tx.to_user_id === userId && tx.status === "released") {
      totalEarned += tx.amount;
      tasksCompleted++;
    }
    if (tx.from_user_id === userId && (tx.status === "escrowed" || tx.status === "released")) {
      totalSpent += tx.amount;
    }
  }

  console.log("\n📊 내 통계\n");

  new Table()
    .body([
      ["💰 현재 잔액", `${balance.toLocaleString()} 크레딧`],
      ["📈 총 기여 획득", `${totalEarned.toLocaleString()} 크레딧`],
      ["📉 총 사용", `${totalSpent.toLocaleString()} 크레딧`],
      ["✅ 완료한 작업", `${tasksCompleted}개`],
    ])
    .border(true)
    .render();

  console.log();
}

export const statsCommand = new Command()
  .name("stats")
  .description("내 크레딧 통계를 표시합니다")
  .action(async () => {
    try {
      await runStats();
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });
