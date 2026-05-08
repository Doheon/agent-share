/**
 * P2P wire-format messages exchanged between ash peers over Hyperswarm.
 *
 * Every connection sends `peer:info` first to identify itself; everything else
 * is task-scoped. Messages are JSON-encoded and newline-delimited on the
 * underlying NoiseSecretStream.
 */

import type { EarnEvent } from "../../shared/events.ts";
import { MAX_BLOB_SIZE, MAX_BLOB_SIZE_B64, MAX_CHUNK_B64 } from "../../shared/protocol.ts";

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

const TASK_ID_TYPES = new Set([
  "task:announce", "task:claim", "task:match", "task:blob_request",
  "task:blob", "task:blob_chunk", "task:diff", "task:settle", "task:cancel", "task:log",
  "task:price_mismatch",
  "spend:cosign", "earn:cosign", "mine:claim",
]);

const CLAIM_ID_TYPES = new Set(["mine:claim", "mine:cosign"]);

/**
 * Validate a parsed P2P message before delivering it to handlers. Drops
 * messages with malformed task_id/claim_id (path-traversal, oversized,
 * non-string), oversized blob announcements, and oversized blob payloads.
 *
 * Adversarial peers can craft any JSON they want — this is the single
 * choke point that prevents downstream handlers from acting on garbage.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isValidMessage(raw: any): boolean {
  if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return false;

  if (TASK_ID_TYPES.has(raw.type) && !isValidId(raw.task_id)) return false;
  if (CLAIM_ID_TYPES.has(raw.type) && !isValidId(raw.claim_id)) return false;

  if (raw.type === "task:announce") {
    if (typeof raw.blob_size !== "number" || !Number.isFinite(raw.blob_size)) return false;
    if (raw.blob_size < 0 || raw.blob_size > MAX_BLOB_SIZE) return false;
    // Cap the prompt — without this, an adversarial requester can ship a
    // multi-MB string in a single message and OOM the acceptor before any
    // of the per-task validation gates run.
    if (typeof raw.prompt !== "string" || raw.prompt.length > 524288) return false;
  }
  if (raw.type === "task:blob") {
    if (typeof raw.data !== "string" || raw.data.length > MAX_BLOB_SIZE_B64) return false;
  }
  if (raw.type === "task:blob_chunk") {
    if (typeof raw.index !== "number" || !Number.isInteger(raw.index) || raw.index < 0) return false;
    if (typeof raw.total !== "number" || !Number.isInteger(raw.total) || raw.total < 1 || raw.total > 2000) return false;
    if (typeof raw.data !== "string" || raw.data.length > MAX_CHUNK_B64) return false;
  }
  if (raw.type === "task:log") {
    // Cap log lines so a hostile peer cannot exhaust memory by spraying
    // megabyte-sized log messages.
    if (typeof raw.line !== "string" || raw.line.length > 16_384) return false;
  }
  if (raw.type === "task:settle") {
    // The TypeScript discriminated union is compile-time only; without
    // a runtime check a peer can send `action: "<arbitrary>"` and the
    // receiver's settleAction promise resolves to a junk value that
    // bypasses both the approve and reject branches. Lock it down.
    if (raw.action !== "approve" && raw.action !== "reject") return false;
  }

  return true;
}

/**
 * Strip ANSI escape sequences and control characters from a log line that
 * came in over the network. A malicious peer could otherwise inject CSI
 * cursor moves, OSC 52 clipboard writes, terminal-title spoofing, or other
 * sequences that hijack the requester's TTY. Apply to anything that
 * crosses the network → terminal boundary.
 */
export function sanitizeLogLine(line: string): string {
  return line
    // CSI: ESC [ ... final byte
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // OSC: ESC ] ... terminated by BEL or ESC \
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    // Other ESC sequences (single-char and intermediate)
    .replace(/\x1b[@-Z\\-_]/g, "")
    // C0 control chars except \t (0x09) and \n (0x0A); also DEL and C1
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export type MineAction =
  | "pr_create"
  | "pr_create_close_rec"
  | "pr_review_approve"
  | "pr_review_changes_requested"
  | "pr_review_close_rec"
  | "pr_fix_self"
  | "pr_fix_feedback"
  | "issue_create";

export type P2PMessage =
  | {
      // Step 1 — sender generates 32 random bytes, sends hex-encoded nonce.
      type: "peer:challenge";
      nonce: string;
    }
  | {
      // Step 2 — receiver signs the received nonce with its Ed25519 private key.
      type: "peer:hello";
      pubkey: string; // Ed25519 identity key (hex)
      sig: string;    // Ed25519 signature over (nonce || theirTransport || ourTransport)
      /** Wire protocol version. Peers refuse mismatched majors at handshake. */
      protocol_version: number;
      /** Semver app version — used to detect pricing policy mismatches. */
      app_version?: string;
    }
  | {
      type: "peer:info";
      pubkey: string;
      username: string;
      model_tier: string;
      /** Hex key of this peer's event Hypercore — used for ledger replication. */
      ledger_core_key?: string;
    }
  | {
      type: "task:announce";
      task_id: string;
      prompt: string;
      model: string;
      blob_size: number;
      requester_pubkey: string;
      rsa_public_key: string;
      timestamp: string;
      /** Hex key of the requester's event Hypercore — used by acceptors to verify balance. */
      requester_ledger_key?: string;
      /** Credit cost the requester expects to pay — acceptors reject if it differs from their policy. */
      credit_cost: number;
    }
  | {
      type: "task:price_mismatch";
      task_id: string;
      /** Acceptor's semver app version. */
      acceptor_app_version: string;
      /** Credit cost the acceptor's policy requires for this model. */
      expected_cost: number;
    }
  | {
      type: "task:claim";
      task_id: string;
      acceptor_pubkey: string;
      rsa_public_key: string;
      next_nonce: number;
    }
  | {
      type: "task:match";
      task_id: string;
      encrypted_aes_key: string;
      blob_iv: string;
    }
  | {
      type: "task:blob_request";
      task_id: string;
    }
  | {
      type: "task:blob";
      task_id: string;
      data: string; // base64-encoded ciphertext (without IV prefix)
    }
  | {
      type: "task:blob_chunk";
      task_id: string;
      index: number;  // 0-based
      total: number;  // total chunk count
      data: string;   // base64-encoded slice of the ciphertext
    }
  | {
      type: "task:diff";
      task_id: string;
      patch: string;
    }
  | {
      type: "task:settle";
      task_id: string;
      action: "approve" | "reject";
    }
  | {
      type: "task:cancel";
      task_id: string;
    }
  | {
      type: "task:log";
      task_id: string;
      line: string;
    }
  | {
      type: "spend:cosign";
      task_id: string;
      spend_event: import("../../shared/events.ts").SpendEvent;
    }
  | {
      type: "earn:cosign";
      task_id: string;
      earn_event: EarnEvent;
    }
  | {
      // Broadcast when a peer completes a GitHub mining action.
      type: "mine:claim";
      claim_id: string;
      claimant_pubkey: string;
      claimant_next_nonce: number;  // helps cosigners build the correct task_id context
      github_ref: string;           // e.g. "pr:Doheon/ash:42"
      task_id: string;              // canonical task_id for the earn event
      action: MineAction;
      amount: number;
      pr_url: string;
      timestamp: string;
    }
  | {
      // Sent back by a peer that independently verified the GitHub action.
      // The claimant uses cosigner_pubkey + cosigner_task_signature to build
      // and self-sign their own EarnEvent (only the log owner can sign it).
      type: "mine:cosign";
      claim_id: string;
      cosigner_pubkey: string;
      // Ed25519 signature over canonical({task_id, amount, claimant_pubkey, action:"earn"})
      cosigner_task_signature: string;
    }
;
