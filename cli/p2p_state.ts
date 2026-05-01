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

// In-memory reservation tally for in-flight spends in this process.
// Without this, a user could fire two concurrent tasks that each see
// balance=B and announce, racing the first append; both acceptors see
// a positive balance and both succeed, driving the local balance below
// zero. Reservations are released when the spend is appended (or when
// the task is cancelled).
const pendingSpendByPubkey = new Map<string, number>();

export function reservePendingSpend(pubkey: string, amount: number): void {
  pendingSpendByPubkey.set(pubkey, (pendingSpendByPubkey.get(pubkey) ?? 0) + amount);
}

export function releasePendingSpend(pubkey: string, amount: number): void {
  const next = (pendingSpendByPubkey.get(pubkey) ?? 0) - amount;
  if (next <= 0) pendingSpendByPubkey.delete(pubkey);
  else pendingSpendByPubkey.set(pubkey, next);
}

export function getPendingSpend(pubkey: string): number {
  return pendingSpendByPubkey.get(pubkey) ?? 0;
}

export async function getLocalBalance(pubkey: string): Promise<BalanceSnapshot> {
  const balance = await _getLocalBalance(pubkey);
  return { pubkey, balance };
}

/**
 * Returns the spendable balance after subtracting in-flight reservations.
 * Use this for credit gating before announcing a task or signing a spend.
 */
export async function getSpendableBalance(pubkey: string): Promise<number> {
  const balance = await _getLocalBalance(pubkey);
  return balance - getPendingSpend(pubkey);
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
