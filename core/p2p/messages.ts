/**
 * P2P wire-format messages exchanged between ash peers over Hyperswarm.
 *
 * Every connection sends `peer:info` first to identify itself; everything else
 * is task-scoped. Messages are JSON-encoded and newline-delimited on the
 * underlying NoiseSecretStream.
 */

import type { EarnEvent } from "../../shared/events.ts";

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
      sig: string;    // Ed25519 signature over the received nonce bytes (hex)
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
