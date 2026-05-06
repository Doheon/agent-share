/**
 * Replicates the admin Hypercore from the source corestore to one or more
 * destination corestores. Run before testing with isolated profiles so they
 * can see admin-issued MintEvents without needing a live P2P session.
 *
 * Usage:
 *   node --import tsx/esm scripts/replicate-admin-core.ts ~/.ash ~/.ash-alice ~/.ash-bob
 */

import { join } from "node:path";
import { ADMIN_LEDGER_KEY } from "../shared/constants.ts";

const [, , src, ...dests] = process.argv;
if (!src || dests.length === 0) {
  console.error("Usage: replicate-admin-core.ts <src-ash-dir> <dest1> [dest2...]");
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openStore(ashDir: string): Promise<any> {
  const { default: Corestore } = await import("corestore") as any;
  const store = new Corestore(join(ashDir, "corestore"));
  await store.ready();
  return store;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getAdminCore(store: any): Promise<any> {
  const core = store.get(Buffer.from(ADMIN_LEDGER_KEY, "hex"), { valueEncoding: "utf-8" });
  await core.ready();
  return core;
}

async function replicateCore(srcCore: any, destCore: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const s1 = srcCore.replicate(true);
    const s2 = destCore.replicate(false);

    s1.pipe(s2).pipe(s1);
    s1.on("error", reject);
    s2.on("error", reject);

    const settle = async () => {
      try {
        await destCore.update({ wait: true });
        // Download all blocks while the replication stream is still open
        const len = destCore.length;
        for (let i = 0; i < len; i++) {
          await destCore.get(i);
        }
        // Gracefully close replication streams
        s1.destroy();
        s2.destroy();
        resolve();
      } catch (err) {
        s1.destroy();
        s2.destroy();
        reject(err);
      }
    };

    // Wait for the pipe to establish, then pull blocks
    setTimeout(settle, 1000);
  });
}

const srcStore = await openStore(src);
const srcCore = await getAdminCore(srcStore);
await srcCore.update();
const length = srcCore.length;
console.log(`source admin core: ${length} events (key: ${ADMIN_LEDGER_KEY.slice(0, 16)}…)`);

if (length === 0) {
  console.log("nothing to replicate.");
  await srcStore.close();
  process.exit(0);
}

for (const dest of dests) {
  console.log(`replicating → ${dest} …`);
  const destStore = await openStore(dest);
  const destCore = await getAdminCore(destStore);
  const before = destCore.length;

  await replicateCore(srcCore, destCore);

  const after = destCore.length;
  console.log(`  before: ${before} events  after: ${after} events`);
  await destStore.close();
}

await srcStore.close();
console.log("done.");
