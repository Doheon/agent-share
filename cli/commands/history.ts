/**
 * ash history [pubkey] — show earn/spend/mint event history.
 *
 * Without a pubkey shows own history. With a pubkey shows that user's
 * public event history (earn/spend from their Hypercore + admin mints).
 */

import { Command } from "commander";
import { loadConfig } from "../client.ts";
import { getEvents, getAdminMintsFor } from "../../core/ledger/events.ts";
import { closeLocalStore, getLocalBalance } from "../p2p_state.ts";
import type { EarnEvent, SpendEvent, MintEvent } from "../../shared/events.ts";

export const historyCommand = new Command("history")
  .description("Show event history (earn/spend/mint)")
  .argument("[pubkey]", "Ed25519 pubkey hex (defaults to own pubkey)")
  .action(async (pubkeyArg?: string) => {
    try {
      let pubkey = pubkeyArg;
      if (!pubkey) {
        const cfg = await loadConfig();
        if (!cfg.pubkey) {
          console.error("\nerror: not initialized. Run: ash init\n");
          process.exit(1);
        }
        pubkey = cfg.pubkey;
      }

      const [ownEvents, mintEvents] = await Promise.all([
        getEvents(pubkey),
        getAdminMintsFor(pubkey),
      ]);

      const all = [...ownEvents, ...mintEvents].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      const label = pubkeyArg ? `${pubkey.slice(0, 16)}…` : "me";
      console.log(`\n  history  ${label}\n`);

      if (all.length === 0) {
        console.log(`  no events\n`);
        return;
      }

      for (const evt of all) {
        const ts = evt.timestamp.slice(0, 19).replace("T", " ");
        if (evt.type === "earn") {
          const e = evt as EarnEvent;
          console.log(`  ${ts}  earn   +${String(e.amount).padStart(4)} cr  from ${e.counterparty_pubkey.slice(0, 8)}…`);
        } else if (evt.type === "spend") {
          const e = evt as SpendEvent;
          console.log(`  ${ts}  spend  -${String(e.amount).padStart(4)} cr  to   ${e.counterparty_pubkey.slice(0, 8)}…`);
        } else if (evt.type === "mint") {
          const e = evt as MintEvent;
          console.log(`  ${ts}  mint   +${String(e.amount).padStart(4)} cr  admin  (${e.reason})`);
        }
      }

      // Validated balance via the same path as `ash status` / requester
      // balance checks — raw event sum can diverge because unverified earns,
      // bad-signature spends, and underflow-skipped spends are dropped here.
      const balance = (await getLocalBalance(pubkey)).balance;
      console.log(`\n  balance: ${balance} cr\n`);
    } catch (err) {
      console.error(`\nerror: ${(err as Error).message}\n`);
      process.exit(1);
    } finally {
      await closeLocalStore().catch(() => undefined);
    }
  });
