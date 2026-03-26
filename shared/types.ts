export type TaskStatus =
  | "pending"
  | "matched"
  | "running"
  | "review"
  | "approved"
  | "rejected"
  | "cancelled"
  | "timeout";

export interface Task {
  id: string;
  requester_id: string;
  acceptor_id: string | null;
  status: TaskStatus;
  encrypted_blob_url: string | null;
  encrypted_aes_key: string | null; // 수락자 공개키로 암호화된 AES 키 (base64)
  diff_result: string | null;
  credit_amount: number;
  prompt: string;
  allowed_hosts: string[];
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  diff_received_at: string | null;
}

export interface Transaction {
  id: string;
  task_id: string | null;
  from_user_id: string;
  to_user_id: string;
  amount: number;
  status: "escrowed" | "released" | "refunded" | "signup_bonus";
  created_at: string;
}

export interface User {
  id: string;
  public_key: string; // RSA 공개키 (PEM)
  created_at: string;
}

export interface UserBalance {
  id: string;
  balance: number;
}

export interface ContributorRanking {
  user_id: string;
  total_contributed: number;
  tasks_completed: number;
}

export interface DaemonConfig {
  schedule: string; // e.g., "mon-fri 09:00-18:00"
  maxConcurrentTasks: number;
  allowedAgents: string[]; // e.g., ["claude", "opencode"]
  apiKeys: Record<string, string>; // agent → api key
}

export interface CryptoBundle {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  encryptedKey: string; // RSA로 암호화된 AES 키 (base64)
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
