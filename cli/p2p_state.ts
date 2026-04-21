/**
 * P2P state helpers — Hypercore-backed global ledger.
 *
 * Each user's events are stored in their own Hypercore inside a shared
 * Corestore at ~/.ash/corestore/. Peers replicate cores over LEDGER_TOPIC
 * (separate Hyperswarm session) so any serve peer can verify a requester's
 * balance before accepting a task.
 */

import {
  appendEvent,
  getCoreKey,
  getEventCount,
  getLocalBalance as _getLocalBalance,
  getRemoteBalance,
} from "../core/ledger/events.ts";
import { closeCorestore } from "../core/ledger/store.ts";
import type { Event } from "../shared/events.ts";

export interface BalanceSnapshot {
  pubkey: string;
  balance: number;
}

export async function getLocalBalance(pubkey: string): Promise<BalanceSnapshot> {
  const balance = await _getLocalBalance(pubkey);
  return { pubkey, balance };
}

export async function getNextNonce(pubkey: string): Promise<number> {
  return getEventCount(pubkey);
}

export async function appendLocalEvent(pubkey: string, event: Event): Promise<void> {
  return appendEvent(pubkey, event);
}

/** Returns the hex key of the given owner's event Hypercore (for peer announcements). */
export async function getLedgerCoreKey(pubkey: string): Promise<string> {
  return getCoreKey(pubkey);
}

/**
 * Returns the balance for a remote peer by replaying their replicated Hypercore.
 * Waits up to 4 s for replication to settle before computing.
 */
export async function getRemotePeerBalance(coreKeyHex: string, recipientPubkey: string): Promise<number> {
  return getRemoteBalance(coreKeyHex, recipientPubkey);
}

export async function closeLocalStore(): Promise<void> {
  return closeCorestore();
}
