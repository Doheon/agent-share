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
  recipient_pubkey: string;   // Ed25519 hex — who receives the credits
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
