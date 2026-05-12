import { getCorestore } from "../core/ledger/store.ts";
import { LEDGER_TOPIC, ADMIN_LEDGER_KEY } from "../shared/constants.ts";

/**
 * Joins the Hyperswarm LEDGER_TOPIC and wires up Corestore replication.
 * Returns the Hyperswarm instance so the caller can destroy it on exit.
 * Non-fatal errors are the caller's responsibility to catch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createLedgerReplicationSwarm(): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { default: Hyperswarm } = (await import("hyperswarm")) as any;
  // eslint-disable-next-line new-cap
  const repSwarm = new Hyperswarm();
  const store = await getCorestore();
  // Open the admin core so Corestore advertises it in every replication
  // session. Without this, peers requesting the admin core by key get no
  // response even though the blocks exist on disk — Corestore only announces
  // cores currently open in memory.
  if (ADMIN_LEDGER_KEY) {
    const ac = store.get(Buffer.from(ADMIN_LEDGER_KEY, "hex"), { valueEncoding: "utf-8" });
    await ac.ready().catch(() => {});
  }
  repSwarm.join(LEDGER_TOPIC);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repSwarm.on("connection", (conn: any) => store.replicate(conn));
  await Promise.race([repSwarm.flush(), new Promise<void>((r) => setTimeout(r, 5000))]);
  return repSwarm;
}
