/**
 * Hypercore log event schema.
 *
 * Every event is appended to the owner's Hypercore, signed with their Ed25519 key.
 * Balance and task state are derived by replaying a user's log through `replay.ts`.
 *
 * Signature covers the canonical JSON of the event with `signature` field removed.
 */

export type EventType =
  | "signup"
  | "signup_bonus"
  | "earn"
  | "spend"
  | "spend_checkpoint"
  | "earn_checkpoint"
  | "mint"
  | "policy_update"
  | "task_created"
  | "task_matched"
  | "task_accepted"
  | "task_reviewed"
  | "task_settled"
  | "task_cancelled";

export interface EventBase {
  type: EventType;
  nonce: number;              // monotonic per-owner
  timestamp: string;          // ISO 8601
  signature: string;          // ed25519 signature (hex) over canonical(event without signature)
  /**
   * Optional explicit signer. When absent, verification uses the log owner's pubkey.
   * Present when the server co-signs on behalf of a party (currently: server-signed
   * `earn` events at settle-approve, so the requester doesn't have to wait for
   * the acceptor to come online).
   */
  signer_pubkey?: string;
}

// --- user events ---

export interface SignupEvent extends EventBase {
  type: "signup";
  username: string;
  ed25519_public_key: string;   // hex
  rsa_public_key: string;       // PEM, used by core/crypto/rsa.ts for AES key exchange
}

/**
 * @deprecated v0.1: signup credits are issued as `MintEvent { reason: "signup" }`
 * from the admin's log. This type is retained to keep the event union stable
 * and to avoid churn in tests; no code path produces it, and replay does not
 * credit it.
 */
export interface SignupBonusEvent extends EventBase {
  type: "signup_bonus";
  amount: number;
}

// --- credit events (co-signed) ---
// counterparty_task_signature = counterparty's ed25519 signature over
//   canonical({ task_id, amount, action: "earn"|"spend" })

export interface EarnEvent extends EventBase {
  type: "earn";
  amount: number;
  task_id: string;
  counterparty_pubkey: string;           // hex
  counterparty_task_signature: string;   // hex
}

export interface SpendEvent extends EventBase {
  type: "spend";
  amount: number;
  task_id: string;
  counterparty_pubkey: string;
  counterparty_task_signature: string;
}

// --- checkpoint events (bilateral signed, replace earn/spend for balance tracking) ---

/**
 * Appended to the requester's core after a task is settled.
 * Both parties sign the same canonical payload (excluding signature fields).
 * balance = absolute balance after this spend (includes admin mints).
 */
export interface SpendCheckpointEvent extends EventBase {
  type: "spend_checkpoint";
  balance: number;
  task_id: string;
  amount: number;
  counterparty_pubkey: string;
  owner_pubkey: string;
  sig_counterparty: string; // acceptor's cosignature
}

/**
 * Appended to the acceptor's core after a task is settled.
 * Both parties sign the same canonical payload (excluding signature fields).
 * balance = absolute balance after this earn (includes admin mints).
 */
export interface EarnCheckpointEvent extends EventBase {
  type: "earn_checkpoint";
  balance: number;
  task_id: string;
  amount: number;
  counterparty_pubkey: string;
  owner_pubkey: string;
  sig_counterparty: string; // requester's cosignature
}

// --- task events in requester's log ---

export interface TaskCreatedEvent extends EventBase {
  type: "task_created";
  task_id: string;
  prompt: string;
  credit_amount: number;
  model: string;
  blob_key: string;
  allowed_hosts: string[];
}

export interface TaskMatchedEvent extends EventBase {
  type: "task_matched";
  task_id: string;
  acceptor_pubkey: string;
  encrypted_aes_key: string;             // RSA-OAEP(AES_key, acceptor_rsa_pub), base64
}

export interface TaskReviewedEvent extends EventBase {
  type: "task_reviewed";
  task_id: string;
  diff_key: string;
}

export interface TaskSettledEvent extends EventBase {
  type: "task_settled";
  task_id: string;
  action: "approve" | "reject";
}

export interface TaskCancelledEvent extends EventBase {
  type: "task_cancelled";
  task_id: string;
  reason: "timeout" | "user_cancelled";
}

// --- task event in acceptor's log ---

export interface TaskAcceptedEvent extends EventBase {
  type: "task_accepted";
  task_id: string;
  requester_pubkey: string;
}

// --- admin-only events (signer_pubkey must match ADMIN_PUBKEY) ---

export interface MintEvent extends EventBase {
  type: "mint";
  recipient_pubkey: string;    // Ed25519 hex — who receives the credits
  recipient_core_key?: string; // Hypercore hex key — when present, mint is only valid on this core
  amount: number;
  reason: string;
}

export interface PolicyUpdateEvent extends EventBase {
  type: "policy_update";
  changes: {
    model_costs?: Record<string, number>;   // tier → credit cost
  };
}

// --- union ---

export type Event =
  | SignupEvent
  | SignupBonusEvent
  | EarnEvent
  | SpendEvent
  | SpendCheckpointEvent
  | EarnCheckpointEvent
  | MintEvent
  | PolicyUpdateEvent
  | TaskCreatedEvent
  | TaskMatchedEvent
  | TaskAcceptedEvent
  | TaskReviewedEvent
  | TaskSettledEvent
  | TaskCancelledEvent;

// --- helpers ---

export function eventWithoutSignature<T extends EventBase>(event: T): Omit<T, "signature"> {
  const { signature: _sig, ...rest } = event;
  return rest as Omit<T, "signature">;
}

/**
 * Returns the canonical payload both parties sign for a checkpoint event.
 * Strips both `signature` (owner sig) and `sig_counterparty` so the payload
 * is identical regardless of signing order.
 */
export function checkpointPayload<T extends EventBase & { sig_counterparty: string }>(
  event: T,
): Omit<T, "signature" | "sig_counterparty"> {
  const { signature: _s, sig_counterparty: _c, ...rest } = event;
  return rest as Omit<T, "signature" | "sig_counterparty">;
}
