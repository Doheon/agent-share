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
import { registerPeerLedgerKey, forgetPeerLedgerKey } from "../../core/ledger/peer_keys.ts";
import { LEDGER_TOPIC } from "../../shared/constants.ts";
import type { P2PMessage } from "../../core/p2p/messages.ts";

const DISCOVER_MS = 8000;

export const peersCommand = new Command("peers")
  .description("Discover active peers and show their balances")
  .option("--forget <pubkey>", "Drop a stale ledger-key mapping (for peers who reset their corestore)")
  .action(async (opts: { forget?: string }) => {
    if (typeof opts.forget === "string" && opts.forget.length > 0) {
      const target = opts.forget.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(target)) {
        console.error("\nerror: --forget expects a 64-char hex pubkey.\n");
        process.exit(2);
      }
      await forgetPeerLedgerKey(target);
      console.log(`\n  forgot cached ledger key for ${target.slice(0, 16)}…\n`);
      return;
    }
    const cfg = await loadConfig();
    if (!cfg.pubkey) {
      console.error("\nerror: not initialized. Run: ash init\n");
      process.exit(1);
    }

    const myPub = cfg.pubkey;
    const myLedgerKey = await getLedgerCoreKey(myPub).catch(() => undefined);
    const identity = await loadIdentity();

    const swarm = new AshSwarm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let repSwarm: any = null;

    try {
      await swarm.join(identity.priv, identity.pubHex);
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

    swarm.onMessage((peer, msg: P2PMessage) => {
      if (msg.type === "peer:info") {
        if (msg.pubkey === myPub) return;
        // Bind self-declared `msg.pubkey` to the handshake-verified
        // identity before persisting anything, otherwise a hostile peer
        // could seed our cache with a mapping under someone else's name.
        if (msg.pubkey !== peer.pubkey) return;
        registerPeerLedgerKey(msg.pubkey, msg.ledger_core_key).catch(() => undefined);
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
    // Fetch balances in parallel — each lookup waits up to 8s for
    // replication, so doing them serially turns a handful of peers into
    // a minute-long pause for the user.
    const entries = await Promise.all(
      Array.from(discovered.entries()).map(async ([pubkey, info]) => {
        let balStr = "  ?  ";
        if (info.ledgerKey) {
          try {
            const bal = await getRemotePeerBalance(info.ledgerKey, pubkey);
            balStr = `${String(bal).padStart(4)} cr`;
          } catch { /* ignore */ }
        }
        return { pubkey, balStr, model: info.model ?? "unknown" };
      }),
    );
    for (const e of entries) {
      console.log(`  ${e.pubkey.slice(0, 16)}…  ${e.balStr}  ${e.model}`);
    }
    console.log();

    await closeLocalStore().catch(() => undefined);
  });
