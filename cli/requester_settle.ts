/**
 * Requester half of the bilateral cosign settlement protocol.
 *
 * Both `ash run` (run.ts) and the TUI chat (chat.tsx) drive an identical
 * sequence after the acceptor returns a diff:
 *
 *   1. Build & sign a SpendCheckpoint inside the per-pubkey mutex.
 *   2. Send `spend:cosign` to the acceptor.
 *   3. Await `task:settle` — verify the acceptor's cosig over our spend
 *      and verify the acceptor's EarnCheckpoint against the snapshot we
 *      captured at task:claim time.
 *   4. On success, append our spend (with the acceptor's cosig) atomically.
 *
 * Keeping this in one place ensures the two callers cannot drift in their
 * verification rules — the only previous reason "earn checkpoint invalid"
 * persisted in the TUI after a fix landed in `ash run` was that the two
 * sites were independent copies of this routine.
 *
 * Earn:cosign is intentionally NOT sent here — the caller does that after
 * the helper returns so it can interleave UI side effects (logging, balance
 * update) appropriately.
 */
import type { KeyObject } from "node:crypto";
import { signEd25519, verifyEd25519, rawHexToPublicKey } from "../core/crypto/ed25519.ts";
import { canonicalStringify } from "../shared/canonical.ts";
import {
  checkpointPayload,
  type SpendCheckpointEvent,
  type EarnCheckpointEvent,
} from "../shared/events.ts";
import { splitFee } from "../shared/policy.ts";
import { appendCheckpointEvent } from "./p2p_state.ts";
import { getRemoteBalance } from "../core/ledger/events.ts";
import type { SwarmPeer } from "../core/p2p/swarm.ts";

/**
 * Subset of `task:claim` we care about for snapshotting. Kept structural so
 * both `run.ts` (P2PMessage union narrowing) and `chat.tsx` (already typed
 * msg) can pass their decoded message in directly.
 */
export interface AcceptorClaimBundle {
  next_nonce: number;
  admin_core_key?: string;
  admin_mints?: unknown[];
  counterparty_admin_mints?: unknown[];
  counterparty_ledger_keys?: Record<string, string>;
}

export type AcceptorSnapshotResult =
  | { ok: true; snapshot: { balance: number; coreLength: number } }
  | { ok: false; reason: "unreachable" | "nonce-mismatch" };

/**
 * Capture the acceptor's pre-task balance + core length using the authoritative
 * bundle they shipped in task:claim. Both callers (run.ts, chat.tsx) MUST go
 * through this so they apply the same overrides and the same length-vs-nonce
 * guard — drift here is what produced the recurring "earn-invalid" the TUI
 * hit after the run.ts fix landed.
 *
 * Caller is responsible for the side effects on failure (send task:cancel,
 * surface a user-visible error, terminate the request flow).
 */
export async function captureAcceptorSnapshot(opts: {
  acceptorLedgerKey: string;
  acceptorPubkey: string;
  claim: AcceptorClaimBundle;
  /** Replication wait — defaults to 5s, matching prior inline behaviour. */
  timeoutMs?: number;
}): Promise<AcceptorSnapshotResult> {
  const snap = await getRemoteBalance(
    opts.acceptorLedgerKey,
    opts.acceptorPubkey,
    opts.timeoutMs ?? 5000,
    opts.claim.admin_core_key,
    opts.claim.admin_mints ?? [],
    opts.claim.counterparty_admin_mints ?? [],
    opts.claim.counterparty_ledger_keys,
  ).catch(() => null);
  if (!snap) return { ok: false, reason: "unreachable" };
  if (snap.coreLength !== opts.claim.next_nonce) {
    return { ok: false, reason: "nonce-mismatch" };
  }
  return { ok: true, snapshot: snap };
}

export type SettleResolver = (msg: {
  action: "approve" | "reject";
  requester_checkpoint_cosig?: string;
  acceptor_earn_checkpoint?: EarnCheckpointEvent;
}) => void;

export interface RequesterSettleOptions {
  taskId: string;
  /** Requester's pubkey hex (= ledger owner). */
  userId: string;
  /** Requester's Ed25519 private key for signing the spend checkpoint. */
  edPriv: KeyObject;
  /** Credits to charge the requester for this task (full or half). */
  amount: number;
  /** Connected acceptor peer — used to send `spend:cosign`. */
  acceptorPeer: SwarmPeer;
  acceptorPubkey: string;
  /**
   * Snapshot of acceptor's pre-task balance + core length. MUST be captured at
   * task:claim time using the authoritative bundle the acceptor shipped
   * (admin_mints / counterparty_admin_mints / counterparty_ledger_keys) — a
   * fresh read here would diverge from the acceptor's local replay.
   */
  acceptorSnapshot: { balance: number; coreLength: number } | null;
  /**
   * Caller's hook into the swarm message stream. Called once with a resolver;
   * the caller stores it and invokes it from its `task:settle` handler. The
   * helper installs a 30s reject timer that wins if the acceptor never replies.
   */
  setSettleResolver: (resolve: SettleResolver) => void;
  /** Override for the settle wait timeout. */
  settleTimeoutMs?: number;
}

export type RequesterSettleErrorTag =
  | "rejected"
  | "missing-cosig"
  | "cosig-invalid"
  | "earn-missing"
  | "earn-no-snapshot"
  | "earn-invalid";

const SETTLE_ERROR_TAGS: ReadonlySet<string> = new Set([
  "rejected",
  "missing-cosig",
  "cosig-invalid",
  "earn-missing",
  "earn-no-snapshot",
  "earn-invalid",
]);

export function isRequesterSettleErrorTag(msg: string): msg is RequesterSettleErrorTag {
  return SETTLE_ERROR_TAGS.has(msg);
}

export interface RequesterSettleResult {
  /** Acceptor's EarnCheckpoint — caller must cosign and send `earn:cosign`. */
  earnCheckpoint: EarnCheckpointEvent;
}

export async function settleAsRequester(opts: RequesterSettleOptions): Promise<RequesterSettleResult> {
  let earnCheckpoint: EarnCheckpointEvent | null = null;

  await appendCheckpointEvent(opts.userId, async (spendNonce, currentBalance) => {
    const spendBase: Omit<SpendCheckpointEvent, "signature"> = {
      type: "spend_checkpoint",
      nonce: spendNonce,
      timestamp: new Date().toISOString(),
      balance: currentBalance - opts.amount,
      amount: opts.amount,
      task_id: opts.taskId,
      counterparty_pubkey: opts.acceptorPubkey,
      owner_pubkey: opts.userId,
      sig_counterparty: "",
    };
    const spendCheckpoint: SpendCheckpointEvent = {
      ...spendBase,
      signature: signEd25519(
        canonicalStringify(checkpointPayload(spendBase as SpendCheckpointEvent)),
        opts.edPriv,
      ),
    };
    opts.acceptorPeer.send({
      type: "spend:cosign",
      task_id: opts.taskId,
      spend_checkpoint: spendCheckpoint,
    });

    const settleMsg = await new Promise<{
      action: "approve" | "reject";
      requester_checkpoint_cosig?: string;
      acceptor_earn_checkpoint?: EarnCheckpointEvent;
    }>((resolve) => {
      let done = false;
      const settle: SettleResolver = (v) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      };
      opts.setSettleResolver(settle);
      const t = setTimeout(() => settle({ action: "reject" }), opts.settleTimeoutMs ?? 30_000);
    });

    if (settleMsg.action !== "approve") throw new Error("rejected");

    const cosig = settleMsg.requester_checkpoint_cosig;
    if (!cosig) throw new Error("missing-cosig");

    const cosigOk = verifyEd25519(
      canonicalStringify(checkpointPayload(spendCheckpoint)),
      cosig,
      rawHexToPublicKey(opts.acceptorPubkey),
    );
    if (!cosigOk) throw new Error("cosig-invalid");

    const aec = settleMsg.acceptor_earn_checkpoint;
    if (!aec) throw new Error("earn-missing");
    if (!opts.acceptorSnapshot) throw new Error("earn-no-snapshot");

    const expectedAcceptorEarn = splitFee(opts.amount).acceptor;
    let aecSigOk = false;
    try {
      aecSigOk = verifyEd25519(
        canonicalStringify(checkpointPayload(aec)),
        aec.signature,
        rawHexToPublicKey(opts.acceptorPubkey),
      );
    } catch { /* malformed */ }

    const aecValid =
      aec.type === "earn_checkpoint" &&
      aec.task_id === opts.taskId &&
      aec.amount === expectedAcceptorEarn &&
      aec.counterparty_pubkey === opts.userId &&
      aec.owner_pubkey === opts.acceptorPubkey &&
      aec.nonce === opts.acceptorSnapshot.coreLength &&
      aec.balance === opts.acceptorSnapshot.balance + expectedAcceptorEarn &&
      aecSigOk;
    if (!aecValid) throw new Error("earn-invalid");

    earnCheckpoint = aec;
    return { ...spendCheckpoint, sig_counterparty: cosig };
  });

  return { earnCheckpoint: earnCheckpoint! };
}
