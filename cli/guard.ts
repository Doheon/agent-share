/**
 * Initialization guard — ensures the user has completed `ash init` (identity
 * keypair, agent credentials, container runtime) before running protected
 * commands. There is no server to check against in the P2P architecture.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ASH_DIR } from "./ash_dir.ts";
import {
  hasIdentity,
  loadAgent,
  loadAgentToken,
  loadConfig,
  loadIdentity,
} from "./client.ts";
import { loadRuntime, detectAvailable } from "../core/sandbox/runtime.ts";
import type { AgentType } from "../shared/types.ts";



export class NotInitializedError extends Error {
  constructor(public reason: string, public hint: string) {
    super(`${reason}\n  → ${hint}`);
    this.name = "NotInitializedError";
  }
}

async function hasCodexSession(): Promise<boolean> {
  try {
    const s = await stat(join(ASH_DIR, "codex-session", ".codex", "auth.json"));
    return s.isFile();
  } catch { return false; }
}

async function hasAgentCredential(agent: AgentType): Promise<boolean> {
  if (agent === "claude") {
    const token = await loadAgentToken();
    return typeof token === "string" && token.length >= 20;
  }
  if (agent === "codex") return await hasCodexSession();
  return false;
}

export interface InitStatus {
  hasKeypair: boolean;
  pubkey: string | null;
  username: string | null;
  agent: AgentType | null;
  agentReady: boolean;
  runtimeReady: boolean;
}

export async function getInitStatus(): Promise<InitStatus> {
  const status: InitStatus = {
    hasKeypair: false,
    pubkey: null,
    username: null,
    agent: null,
    agentReady: false,
    runtimeReady: false,
  };

  status.hasKeypair = await hasIdentity();
  if (status.hasKeypair) {
    try {
      const id = await loadIdentity();
      status.pubkey = id.pubHex;
    } catch { /* corrupt keypair */ }
    const cfg = await loadConfig();
    status.username = cfg.username ?? null;
  }

  try {
    status.agent = await loadAgent();
    status.agentReady = await hasAgentCredential(status.agent);
  } catch { /* no agent configured */ }

  const saved = await loadRuntime();
  if (saved) status.runtimeReady = true;
  else {
    const { podman, docker } = await detectAvailable();
    status.runtimeReady = podman || docker;
  }
  return status;
}

export async function ensureInitialized(): Promise<string> {
  const s = await getInitStatus();
  if (!s.hasKeypair || !s.pubkey) {
    throw new NotInitializedError(
      "No local identity key.",
      "Run: ash init",
    );
  }
  if (!s.agentReady) {
    const name = s.agent === "codex" ? "Codex" : "Claude Code";
    throw new NotInitializedError(
      `${name} credentials are missing.`,
      "Run: ash init",
    );
  }
  if (!s.runtimeReady) {
    throw new NotInitializedError(
      "No container runtime (podman/docker) available.",
      "Run: ash setup",
    );
  }
  return s.pubkey;
}
