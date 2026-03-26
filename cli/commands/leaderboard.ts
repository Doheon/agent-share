/**
 * agent-share leaderboard [--limit 20]
 * contributor_rankings 뷰에서 상위 기여자를 표로 출력합니다.
 */

import { Command } from "cliffy/command";
import { Table } from "cliffy/table";
import { getClient, getCurrentUserId } from "../client.ts";
import type { ContributorRanking } from "../../shared/types.ts";

interface LeaderboardOptions {
  limit: number;
}

async function runLeaderboard(options: LeaderboardOptions): Promise<void> {
  const client = await getClient();
  const userId = await getCurrentUserId();

  const { data, error } = await client
    .from("contributor_rankings")
    .select("*")
    .order("total_contributed", { ascending: false })
    .limit(options.limit);

  if (error) {
    throw new Error(`리더보드 조회 실패: ${error.message}`);
  }

  const rankings = (data ?? []) as ContributorRanking[];

  if (rankings.length === 0) {
    console.log("아직 기여자가 없습니다.");
    return;
  }

  console.log("\n🏆 기여자 리더보드\n");

  const rows = rankings.map((r, idx) => {
    const isMe = r.user_id === userId;
    const rank = `${idx + 1}`;
    const shortId = r.user_id.slice(0, 8) + "...";
    const contributed = r.total_contributed.toLocaleString();
    const completed = r.tasks_completed.toString();
    const you = isMe ? " ← you" : "";

    return isMe
      ? [rank, `${shortId}${you}`, contributed, completed].map((v) => `\x1b[32m${v}\x1b[0m`)
      : [rank, shortId, contributed, completed];
  });

  new Table()
    .header(["순위", "사용자 ID", "총 기여 크레딧", "완료 작업 수"])
    .body(rows)
    .border(true)
    .render();

  console.log();
}

export const leaderboardCommand = new Command()
  .name("leaderboard")
  .description("기여자 리더보드를 표시합니다")
  .option("--limit <n:number>", "표시할 최대 항목 수", { default: 20 })
  .action(async (options) => {
    try {
      await runLeaderboard({ limit: options.limit });
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });
