/**
 * Per-user event Hypercore operations.
 *
 * Each user's earn/spend events are stored in their own Hypercore inside
 * the shared Corestore at ~/.ash/corestore/. The admin's MintEvents are
 * stored in the admin's own Hypercore (named by ADMIN_PUBKEY) and read by
 * all peers during balance calculation.
 */

import { getCorestore } from "./store.ts";
import type { Event } from "../../shared/events.ts";
import { eventWithoutSignature } from "../../shared/events.ts";
import { ADMIN_PUBKEY, ADMIN_LEDGER_KEY } from "../../shared/constants.ts";
import { verifyEd25519, rawHexToPublicKey } from "../crypto/ed25519.ts";
import { canonicalStringify } from "../../shared/canonical.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getUserCore(ownerPubkeyHex: string): Promise<any> {
  const store = await getCorestore();
  const ns = store.namespace("ash-events");
  const core = ns.get({ name: ownerPubkeyHex, valueEncoding: "utf-8" });
  await core.ready();
  return core;
}

/** Returns the hex key of the given owner's event Hypercore. */
export async function getCoreKey(ownerPubkeyHex: string): Promise<string> {
  const core = await getUserCore(ownerPubkeyHex);
  return (core.key as Buffer).toString("hex");
}

/** Returns how many events are in the owner's Hypercore (= next nonce). */
export async function getEventCount(ownerPubkeyHex: string): Promise<number> {
  const core = await getUserCore(ownerPubkeyHex);
  return core.length as number;
}

/** Appends a signed event to the owner's Hypercore. */
export async function appendEvent(ownerPubkeyHex: string, event: Event): Promise<void> {
  const core = await getUserCore(ownerPubkeyHex);
  await core.append(JSON.stringify(event));
}

/**
 * Replays earn/spend events from a core to compute base balance.
 *
 * Replay-time invariants (forgery defense):
 *   1. SpendEvent must be signed by the log owner. Prevents third-party
 *      tampering during Hypercore replication.
 *   2. EarnEvent must be signed by `counterparty_pubkey`. Mirrors the
 *      wire-level check at serve.ts earn-cosign validation.
 *   3. EarnEvent must correspond to a matching SpendEvent on the
 *      counterparty's own log. Closes the "fake counterparty keypair"
 *      forgery: an attacker who mints a throwaway keypair Y and self-signs
 *      an earn in their own log cannot produce a matching spend in Y's
 *      core (Y is empty or never replicated), so the earn is dropped.
 *   4. Running balance stays ≥ 0. A spend that would drive balance negative
 *      is skipped rather than applied; defense-in-depth against a
 *      compromised owner signing an over-spend.
 *
 * Any event that fails these checks is treated as malformed and skipped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function replayBalance(core: any, ownerPubkeyHex: string): Promise<number> {
  let balance = 0;
  const len: number = core.length;
  let ownerPubKey: ReturnType<typeof rawHexToPublicKey> | null = null;
  try {
    ownerPubKey = rawHexToPublicKey(ownerPubkeyHex);
  } catch {
    return 0;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coreCache = new Map<string, any>();
  for (let i = 0; i < len; i++) {
    try {
      const raw = await core.get(i) as string;
      const event = JSON.parse(raw) as Event;
      if (event.type === "spend") {
        const ok = verifyEd25519(
          canonicalStringify(eventWithoutSignature(event)),
          event.signature,
          ownerPubKey,
        );
        if (!ok) continue;
        if (balance - event.amount < 0) continue;
        balance -= event.amount;
      } else if (event.type === "earn") {
        if (!(await verifyEarnCrossRef(event, ownerPubkeyHex, coreCache))) continue;
        balance += event.amount;
      }
    } catch {
      // skip malformed entries
    }
  }
  return balance;
}

/**
 * Validates a single EarnEvent observed in `ownerPubkeyHex`'s log:
 *   - signature verifies against `counterparty_pubkey`
 *   - counterparty's log contains a matching SpendEvent (same task_id,
 *     same amount ≥ earn.amount when fees apply in future, counterparty ===
 *     owner, and signed by counterparty)
 *
 * Returns true if the earn should be credited.
 */
async function verifyEarnCrossRef(
  earn: Extract<Event, { type: "earn" }>,
  ownerPubkeyHex: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coreCache: Map<string, any>,
): Promise<boolean> {
  let counterpartyPub;
  try {
    counterpartyPub = rawHexToPublicKey(earn.counterparty_pubkey);
  } catch {
    return false;
  }
  const earnSigOk = verifyEd25519(
    canonicalStringify(eventWithoutSignature(earn)),
    earn.signature,
    counterpartyPub,
  );
  if (!earnSigOk) return false;

  // Cross-ref: find a matching signed SpendEvent on the counterparty's log.
  let cpCore = coreCache.get(earn.counterparty_pubkey);
  if (!cpCore) {
    try {
      cpCore = await getUserCore(earn.counterparty_pubkey);
      coreCache.set(earn.counterparty_pubkey, cpCore);
    } catch {
      return false;
    }
  }
  const cpLen: number = cpCore.length ?? 0;
  if (cpLen === 0) return false;
  for (let j = 0; j < cpLen; j++) {
    try {
      const raw = await cpCore.get(j) as string;
      const ev = JSON.parse(raw) as Event;
      if (
        ev.type === "spend" &&
        ev.task_id === earn.task_id &&
        ev.amount >= earn.amount &&
        ev.counterparty_pubkey === ownerPubkeyHex
      ) {
        const sigOk = verifyEd25519(
          canonicalStringify(eventWithoutSignature(ev)),
          ev.signature,
          counterpartyPub,
        );
        if (sigOk) return true;
      }
    } catch { /* skip */ }
  }
  return false;
}

/**
 * Reads the admin's Hypercore and sums all valid MintEvents
 * targeting the given recipient pubkey.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openAdminCore(): Promise<any | null> {
  if (!ADMIN_PUBKEY) return null;
  if (ADMIN_LEDGER_KEY) {
    // Open by actual Hypercore key for cross-machine replication.
    const store = await getCorestore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core: any = store.get(Buffer.from(ADMIN_LEDGER_KEY, "hex"), { valueEncoding: "utf-8" });
    await core.ready();
    return core;
  }
  // Fallback: local name-based core (admin on same machine).
  return getUserCore(ADMIN_PUBKEY);
}

async function replayAdminMints(recipientPubkey: string): Promise<number> {
  if (!ADMIN_PUBKEY) return 0;
  try {
    const adminCore = await openAdminCore();
    if (!adminCore || adminCore.length === 0) return 0;
    const adminPubKey = rawHexToPublicKey(ADMIN_PUBKEY);
    let total = 0;
    // Invariant: at most one `reason: "signup"` mint per recipient is credited.
    // Protects against duplicate mints from a buggy watcher or manual retry.
    let signupCounted = false;
    for (let i = 0; i < adminCore.length; i++) {
      try {
        const raw = await adminCore.get(i) as string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const event = JSON.parse(raw) as any;
        if (
          event.type !== "mint" ||
          event.recipient_pubkey !== recipientPubkey ||
          event.signer_pubkey !== ADMIN_PUBKEY
        ) continue;
        const valid = verifyEd25519(
          canonicalStringify(eventWithoutSignature(event)),
          event.signature,
          adminPubKey,
        );
        if (!valid) continue;
        if (event.reason === "signup") {
          if (signupCounted) continue;
          signupCounted = true;
        }
        total += event.amount;
      } catch { /* skip malformed */ }
    }
    return total;
  } catch {
    return 0;
  }
}

/** Returns the balance for the given owner by replaying their local Hypercore. */
export async function getLocalBalance(ownerPubkeyHex: string): Promise<number> {
  const core = await getUserCore(ownerPubkeyHex);
  const base = await replayBalance(core, ownerPubkeyHex);
  const mints = await replayAdminMints(ownerPubkeyHex);
  return base + mints;
}

/**
 * Opens a remote Hypercore by key, waits up to `timeoutMs` for replication,
 * and returns the replayed balance (earn/spend + admin mints).
 */
export async function getRemoteBalance(
  coreKeyHex: string,
  recipientPubkey: string,
  timeoutMs = 4000,
): Promise<number> {
  const store = await getCorestore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core: any = store.get(
    Buffer.from(coreKeyHex, "hex"),
    { valueEncoding: "utf-8" },
  );
  await core.ready();

  const updates: Promise<void>[] = [core.update()];
  if (ADMIN_PUBKEY) {
    updates.push(
      openAdminCore()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((ac: any) => ac?.update())
        .catch(() => {}),
    );
  }

  await Promise.race([
    Promise.all(updates),
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]);

  const base = await replayBalance(core, recipientPubkey);
  const mints = await replayAdminMints(recipientPubkey);
  return base + mints;
}

/** Returns all raw events from the owner's own Hypercore (earn/spend). */
export async function getEvents(ownerPubkeyHex: string): Promise<Event[]> {
  const core = await getUserCore(ownerPubkeyHex);
  const events: Event[] = [];
  for (let i = 0; i < core.length; i++) {
    try {
      const raw = await core.get(i) as string;
      events.push(JSON.parse(raw) as Event);
    } catch { /* skip malformed */ }
  }
  return events;
}

/** Returns all valid MintEvents from the admin core targeting the given recipient. */
export async function getAdminMintsFor(recipientPubkey: string): Promise<Event[]> {
  if (!ADMIN_PUBKEY) return [];
  try {
    const adminCore = await openAdminCore();
    if (adminCore.length === 0) return [];
    const adminPubKey = rawHexToPublicKey(ADMIN_PUBKEY);
    const mints: Event[] = [];
    for (let i = 0; i < adminCore.length; i++) {
      try {
        const raw = await adminCore.get(i) as string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const event = JSON.parse(raw) as any;
        if (event.type === "mint" && event.recipient_pubkey === recipientPubkey) {
          const valid = verifyEd25519(
            canonicalStringify(eventWithoutSignature(event)),
            event.signature,
            adminPubKey,
          );
          if (valid) mints.push(event as Event);
        }
      } catch { /* skip */ }
    }
    return mints;
  } catch { return []; }
}
