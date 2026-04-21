/**
 * Local identity, configuration, and per-user metadata.
 *
 * In the fully P2P architecture there is no remote server: this file owns
 * the on-disk layout under ~/.ash/ and exposes the helpers that were
 * previously bundled with the HTTP client.
 *
 * Layout:
 *   ~/.ash/config.json        — username, pubkey, model tier, agent, runtime
 *   ~/.ash/keys/identity.ed25519[.pub] — Ed25519 identity keypair
 *   ~/.ash/logs/              — Hypercore append-only event log (per pubkey)
 *   ~/.agent-share/keys/<pubkey>.pem  — RSA-OAEP keypair for AES key exchange
 */

import { join } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { ASH_DIR } from "./ash_dir.ts";
import type { KeyObject } from "node:crypto";
import {
  exportEd25519PrivatePem,
  exportEd25519PublicPem,
  generateEd25519KeyPair,
  importEd25519PrivatePem,
  importEd25519PublicPem,
  publicKeyToRawHex,
} from "../core/crypto/ed25519.ts";
import type { AgentType, Model } from "../shared/types.ts";
import { DEFAULT_MODEL_TIER, modelToAgent } from "../shared/types.ts";
import { MODELS } from "../shared/policy.ts";

const CONFIG_PATH = join(ASH_DIR, "config.json");
const KEYS_DIR = join(ASH_DIR, "keys");
const ED25519_PRIV = join(KEYS_DIR, "identity.ed25519");
const ED25519_PUB  = join(KEYS_DIR, "identity.ed25519.pub");

// --- config ---

export interface AshConfig {
  username?: string;
  pubkey?: string;           // ed25519 hex
  modelTier?: string;
  agent?: AgentType;
  agentToken?: string;
  runtime?: "podman" | "docker";
  githubToken?: string;      // GitHub personal access token (repo scope) for mining
}

let _config: AshConfig | null = null;

export function invalidateConfigCache(): void {
  _config = null;
}

export async function loadConfig(forceRefresh = false): Promise<AshConfig> {
  if (_config && !forceRefresh) return _config;
  try {
    _config = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as AshConfig;
  } catch {
    _config = {};
  }
  return _config;
}

export async function saveConfig(patch: Partial<AshConfig>): Promise<void> {
  await mkdir(ASH_DIR, { recursive: true });
  const current = await loadConfig().catch(() => ({} as AshConfig));
  const merged = { ...current, ...patch };
  await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
  _config = merged;
}

export async function saveModelTier(tier: string): Promise<void> {
  await saveConfig({ modelTier: tier, agent: modelToAgent(tier) });
}

export async function loadModelTier(): Promise<string> {
  return (await loadConfig()).modelTier ?? DEFAULT_MODEL_TIER;
}

export async function saveAgent(agent: AgentType): Promise<void> {
  await saveConfig({ agent });
}

export async function loadAgent(): Promise<AgentType> {
  const c = await loadConfig();
  if (c.modelTier) return modelToAgent(c.modelTier);
  return c.agent ?? "claude";
}

export async function saveAgentToken(token: string): Promise<void> {
  await saveConfig({ agentToken: token });
}

export async function loadAgentToken(): Promise<string | null> {
  return (await loadConfig()).agentToken ?? null;
}

// --- identity keypair (Ed25519) ---

export async function hasIdentity(): Promise<boolean> {
  try { await stat(ED25519_PRIV); return true; } catch { return false; }
}

export async function createIdentity(): Promise<{ priv: KeyObject; pub: KeyObject; pubHex: string }> {
  await mkdir(KEYS_DIR, { recursive: true });
  const { privateKey, publicKey } = generateEd25519KeyPair();
  await writeFile(ED25519_PRIV, exportEd25519PrivatePem(privateKey), { mode: 0o600 });
  await writeFile(ED25519_PUB, exportEd25519PublicPem(publicKey), { mode: 0o644 });
  return { priv: privateKey, pub: publicKey, pubHex: publicKeyToRawHex(publicKey) };
}

export async function loadIdentity(): Promise<{ priv: KeyObject; pub: KeyObject; pubHex: string }> {
  try {
    const privPem = await readFile(ED25519_PRIV, "utf-8");
    const pubPem = await readFile(ED25519_PUB, "utf-8");
    const priv = importEd25519PrivatePem(privPem);
    const pub = importEd25519PublicPem(pubPem);
    return { priv, pub, pubHex: publicKeyToRawHex(pub) };
  } catch {
    throw new Error(`Identity key not found at ${ED25519_PRIV}. Run \`ash init\`.`);
  }
}

export async function getOrCreateIdentity() {
  return (await hasIdentity()) ? await loadIdentity() : await createIdentity();
}

// --- identity convenience accessors ---

export async function getCurrentPubkey(): Promise<string> {
  const cfg = await loadConfig();
  if (cfg.pubkey) return cfg.pubkey;
  const id = await loadIdentity();
  return id.pubHex;
}

// --- model registry ---
//
// In the P2P world there is no model registry endpoint — every peer relies
// on the same hard-coded table. New tiers are introduced by client upgrades.

export async function loadModels(): Promise<Model[]> {
  return [...MODELS];
}
