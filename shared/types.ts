/**
 * Shared types used across the P2P client.
 *
 * Tasks no longer have a server-side identity — each peer keeps its own view
 * of the in-flight task. `LocalTask` is the requester/acceptor in-memory
 * snapshot; persistent state lives in each owner's Hypercore log.
 */

export type AgentType = "claude" | "codex";

// ModelTier is a free-form string identifying which AI model a request targets.
// Known values: "claude-sonnet", "claude-opus", "claude-haiku", "codex".
export type ModelTier = string;

/** Returns true when `v` is a non-empty string of at most 64 characters. */
export function isValidModelTier(v: string): v is ModelTier {
  return v.length > 0 && v.length <= 64;
}

export interface Model {
  tier: string;
  display_name: string;
  credits: number;
  is_active: boolean;
}

export const DEFAULT_MODEL_TIER = "claude-sonnet";

// MODEL_CREDITS moved to shared/policy.ts — import from there.

export function modelToAgent(tier: ModelTier): AgentType {
  return tier === "codex" ? "codex" : "claude";
}

export type TaskStatus =
  | "open"
  | "running"
  | "review"
  | "approved"
  | "rejected"
  | "cancelled";

/** In-memory snapshot of a task as it moves through the P2P flow. */
export interface LocalTask {
  task_id: string;
  requester_pubkey: string;
  acceptor_pubkey: string | null;
  stage: TaskStatus;
  prompt: string;
  credit_amount: number;
  model: string;
  allowed_hosts: string[];
  created_at: string;
}

export interface ScanResult {
  file: string;
  line: number;
  pattern: string;
  match: string;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DiffResult {
  patch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}
