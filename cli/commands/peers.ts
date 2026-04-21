/**
 * ash peers — discover active peers on the task network and show their balances.
 *
 * Joins the Hyperswarm task topic briefly, collects peer:info messages,
 * then checks each peer's balance via their Hypercore ledger key.
 */

import { Command } from "commander";
import { loadConfig, loadIdentity } from "../client.ts";
import { getLedgerCoreKey, getRemotePeerBalance, closeLocalStore } from "../p2p_state.ts";
import { AshSwarm } from "../../core/p2p/swarm.ts";
import { getCorestore } from "../../core/ledger/store.ts";
import { LEDGER_TOPIC } from "../../shared/constants.ts";
import type { P2PMessage } from "../../core/p2p/messages.ts";

const DISCOVER_MS = 8000;

export const peersCommand = new Command("peers")
  .description("Discover active peers and show their balances")
  .action(async () => {
    const cfg = await loadConfig();
    if (!cfg.pubkey) {
      console.error("\nerror: not initialized. Run: ash init\n");
      process.exit(1);
    }

    const myPub = cfg.pubkey;
    const myLedgerKey = await getLedgerCoreKey(myPub).catch(() => undefined);

    const swarm = new AshSwarm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let repSwarm: any = null;

    try {
      await swarm.join();
    } catch (err) {
      console.error(`\n  Failed to join network: ${(err as Error).message}\n`);
      await closeLocalStore().catch(() => undefined);
      process.exit(1);
    }

    // Join ledger replication so we can fetch peer balances.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { default: Hyperswarm } = (await import("hyperswarm")) as any;
      repSwarm = new Hyperswarm();
      const store = await getCorestore();
      repSwarm.join(LEDGER_TOPIC);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repSwarm.on("connection", (conn: any) => store.replicate(conn));
    } catch { /* non-fatal */ }

    const discovered = new Map<string, { ledgerKey?: string; model?: string }>();

    swarm.onMessage((_peer, msg: P2PMessage) => {
      if (msg.type === "peer:info") {
        if (msg.pubkey === myPub) return;
        discovered.set(msg.pubkey, {
          ledgerKey: msg.ledger_core_key,
          model: msg.model_tier,
        });
      }
    });

    // Broadcast our own peer:info so others respond.
    swarm.broadcast({
      type: "peer:info",
      pubkey: myPub,
      ledger_core_key: myLedgerKey,
    } as P2PMessage);

    process.stdout.write(`\n  Scanning network for ${DISCOVER_MS / 1000}s…`);
    await new Promise<void>((r) => setTimeout(r, DISCOVER_MS));
    process.stdout.write("\n\n");

    await repSwarm?.destroy().catch(() => {});
    await swarm.destroy().catch(() => undefined);

    if (discovered.size === 0) {
      console.log("  No peers found.\n");
      await closeLocalStore().catch(() => undefined);
      return;
    }

    console.log(`  Found ${discovered.size} peer(s):\n`);
    for (const [pubkey, info] of discovered) {
      let balStr = "  ?  ";
      if (info.ledgerKey) {
        try {
          const bal = await getRemotePeerBalance(info.ledgerKey, pubkey);
          balStr = `${String(bal).padStart(4)} cr`;
        } catch { /* ignore */ }
      }
      const model = info.model ?? "unknown";
      console.log(`  ${pubkey.slice(0, 16)}…  ${balStr}  ${model}`);
    }
    console.log();

    await closeLocalStore().catch(() => undefined);
  });
