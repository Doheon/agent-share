/**
 * ash list — 수락 가능한 open 작업 목록 조회
 */

import { Command } from "cliffy/command";
import { Table } from "cliffy/table";
import { getClient } from "../client.ts";
import type { Task } from "../../shared/types.ts";

async function runList(options: { limit: number }): Promise<void> {
  const client = await getClient();

  const { data, error } = await client
    .from("tasks")
    .select("id, prompt, credit_amount, created_at, allowed_hosts")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(options.limit);

  if (error) throw new Error(`목록 조회 실패: ${error.message}`);

  if (!data || data.length === 0) {
    console.log("\n현재 수락 가능한 작업이 없습니다.\n");
    return;
  }

  console.log(`\n📋 수락 가능한 작업 (${data.length}개)\n`);

  new Table()
    .header(["ID (앞 8자)", "크레딧", "프롬프트", "등록일"])
    .body(
      data.map((t: Task) => [
        t.id.slice(0, 8),
        `${t.credit_amount}`,
        t.prompt ? (t.prompt.length > 50 ? t.prompt.slice(0, 47) + "..." : t.prompt) : "-",
        new Date(t.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
      ]),
    )
    .border(true)
    .render();

  console.log(`\n수락하려면: ash accept <ID>\n`);
}

export const listCommand = new Command()
  .name("list")
  .description("수락 가능한 작업 목록 조회")
  .option("--limit <n:number>", "최대 표시 개수", { default: 20 })
  .action(async (options) => {
    try {
      await runList(options);
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });
