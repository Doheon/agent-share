/**
 * agent-share CLI 진입점
 */

import { Command } from "cliffy/command";
import { Table } from "cliffy/table";
import { acceptCommand } from "./commands/accept.ts";
import { submitCommand } from "./commands/submit.ts";
import { reviewCommand, approveCommand, rejectCommand } from "./commands/review.ts";
import { daemonCommand, daemonRunCommand } from "./commands/daemon.ts";
import { leaderboardCommand } from "./commands/leaderboard.ts";
import { statsCommand } from "./commands/stats.ts";
import { setupCommand } from "./commands/setup.ts";
import { loginCommand, logoutCommand, signupCommand } from "./commands/login.ts";
import { listCommand } from "./commands/list.ts";
import { getClient, getCurrentUserId } from "./client.ts";
import type { UserBalance } from "../shared/types.ts";

await new Command()
  .name("ash")
  .version("0.1.0")
  .description("AI 코딩 에이전트 리소스 공유 플랫폼")
  .command("signup", signupCommand)
  .command("login", loginCommand)
  .command("logout", logoutCommand)
  .command("setup", setupCommand)
  .command("submit", submitCommand)
  .command("list", listCommand)
  .command("accept", acceptCommand)
  .command("review", reviewCommand)
  .command("approve", approveCommand)
  .command("reject", rejectCommand)
  .command("daemon", daemonCommand)
  .command("leaderboard", leaderboardCommand)
  .command("stats", statsCommand)
  .command("_daemon-run", daemonRunCommand)
  .command(
    "balance",
    new Command()
      .description("크레딧 잔액 조회")
      .action(async () => {
        try {
          const client = await getClient();
          const userId = await getCurrentUserId();

          const { data, error } = await client
            .from("user_balances")
            .select("*")
            .eq("user_id", userId)
            .single();

          if (error && error.code !== "PGRST116") {
            throw new Error(`잔액 조회 실패: ${error.message}`);
          }

          const balance = (data as UserBalance | null)?.balance ?? 0;

          console.log("\n💰 크레딧 잔액\n");
          new Table()
            .body([["잔액", `${balance.toLocaleString()} 크레딧`]])
            .border(true)
            .render();
          console.log();
        } catch (err) {
          console.error(`\n❌ 오류:`, (err as Error).message);
          Deno.exit(1);
        }
      }),
  )
  .parse(Deno.args);
