/**
 * Persistent pubkey -> ledger_core_key mapping.
 *
 * A user's event Hypercore is keyed by a random keypair derived from that
 * user's local Corestore primary key — it is NOT the same as their Ed25519
 * identity pubkey. So `namespace("ash-events").get({ name: pubkey })` on a
 * remote machine produces an empty local stub, not the peer's actual core.
 *
 * Every time we learn a (pubkey, ledger_core_key) pair from a peer:info or
 * task:announce message we store it here. `verifyEarnCrossRef` then opens
 * the counterparty's real core by hex key instead of creating an empty one,
 * which is what makes earn events actually count toward the balance.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ASH_DIR } from "../../cli/ash_dir.ts";

const PEER_KEYS_PATH = join(ASH_DIR, "peer_ledger_keys.json");

let cache: Record<string, string> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function loadCache(): Promise<Record<string, string>> {
  if (cache) return cache;
  try {
    const raw = await readFile(PEER_KEYS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = (parsed && typeof parsed === "object") ? parsed as Record<string, string> : {};
  } catch {
    cache = {};
  }
  return cache;
}

export async function getPeerLedgerKey(pubkey: string): Promise<string | undefined> {
  if (!pubkey) return undefined;
  const c = await loadCache();
  return c[pubkey];
}

export async function registerPeerLedgerKey(
  pubkey: string | undefined,
  coreKeyHex: string | undefined,
): Promise<void> {
  if (!pubkey || !coreKeyHex) return;
  const c = await loadCache();
  if (c[pubkey] === coreKeyHex) return;
  c[pubkey] = coreKeyHex;
  const snapshot = { ...c };
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(PEER_KEYS_PATH), { recursive: true });
      await writeFile(PEER_KEYS_PATH, JSON.stringify(snapshot, null, 2), "utf8");
    });
  await writeQueue.catch(() => undefined);
}
