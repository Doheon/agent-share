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

// Per-pubkey async mutex. Without it, two flows in the same process
// (e.g. /mine running while a /serve task completes, or chat + mine
// racing inside the TUI) can both call getNextNonce → both see the same
// length N → both build events with nonce=N → both append. The on-wire
// log holds two entries at offsets N and N+1 sharing the same nonce;
// replayBalance dedupes spends by nonce so one of them silently drops
// from the user's balance, while earns dedupe by task_id and so both
// land — net effect: exploitable balance inflation. The cross-process
// path is already covered by the corestore lock.
const appendLockByPubkey = new Map<string, Promise<unknown>>();

/**
 * Atomic "compute next nonce → build event → append" sequence for a
 * single pubkey. Use this whenever an event's nonce comes from
 * getNextNonce(myPub) — it eliminates the read-then-write race that
 * lets concurrent flows assign the same nonce to different events.
 */
export async function appendNextEvent(
  pubkey: string,
  build: (nonce: number) => Event | Promise<Event>,
): Promise<void> {
  const prev = appendLockByPubkey.get(pubkey) ?? Promise.resolve();
  const work = prev
    .catch(() => undefined) // a prior caller's failure must not block ours
    .then(async () => {
      const nonce = await getEventCount(pubkey);
      const event = await build(nonce);
      await appendEvent(pubkey, event);
    });
  // Chain the next caller behind us; swallow rejection on the chain side
  // so it doesn't bubble to whoever lands here next.
  appendLockByPubkey.set(pubkey, work.catch(() => undefined));
  return work;
}

/**
 * Atomic "read balance + nonce → build checkpoint → append" for a pubkey.
 * Both balance and nonce are read inside the per-pubkey mutex so the checkpoint's
 * `balance` field is consistent with the core length at append time. The build
 * function may do async I/O (including network waits) while holding the lock —
 * this serialises checkpoint settlements for the same pubkey, which is correct
 * and prevents two concurrent tasks from stamping the same stale balance.
 */
export async function appendCheckpointEvent(
  pubkey: string,
  build: (nonce: number, balance: number) => Event | Promise<Event>,
): Promise<void> {
  const prev = appendLockByPubkey.get(pubkey) ?? Promise.resolve();
  const work = prev
    .catch(() => undefined)
    .then(async () => {
      const nonce = await getEventCount(pubkey);
      // waitForBlocks=true: checkpoint settlement runs in an active swarm so we
      // can pull missing counterparty blocks on demand. This makes cross-ref
      // deterministic and the resulting balance match what the requester computes.
      const balance = await _getLocalBalance(pubkey, true);
      const event = await build(nonce, balance);
      await appendEvent(pubkey, event);
    });
  appendLockByPubkey.set(pubkey, work.catch(() => undefined));
  return work;
}

/** Returns the hex key of the given owner's event Hypercore (for peer announcements). */
export async function getLedgerCoreKey(pubkey: string): Promise<string> {
  return getCoreKey(pubkey);
}

/**
 * Returns the balance and replicated core length for a remote peer.
 * The coreLength is the peer's Hypercore.length after replication — use it to
 * validate that an incoming checkpoint's nonce equals the expected next position.
 */
export async function getRemotePeerBalance(
  coreKeyHex: string,
  recipientPubkey: string,
): Promise<{ balance: number; coreLength: number }> {
  return getRemoteBalance(coreKeyHex, recipientPubkey);
}

export async function closeLocalStore(): Promise<void> {
  return closeCorestore();
}
