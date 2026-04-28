/**
 * ash init — first-run setup for the P2P client.
 *
 *   1. Generate Ed25519 + RSA keypairs (if missing).
 *   2. Persist the chosen username to ~/.ash/config.json.
 *   3. Pick AI agent (Claude Code | Codex), verify login, cache long-lived token.
 *   4. Run environment checks (runtime, sandbox image, directories).
 *
 * No server signup — identity is the keypair itself.
 */

import { Command } from "commander";
import { input, select, confirm } from "@inquirer/prompts";
import { stat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { ASH_DIR } from "../ash_dir.ts";
import {
  getOrCreateIdentity,
  loadAgentToken,
  loadConfig,
  loadIdentity,
  saveAgent,
  saveAgentToken,
  saveConfig,
} from "../client.ts";
import { runSetup } from "./setup.ts";
import { getOrCreateKeyPair } from "../../core/crypto/keypair.ts";
import { exportPublicKeyPem } from "../../core/crypto/rsa.ts";
import type { AgentType } from "../../shared/types.ts";
import { spawn } from "../../core/util/spawn.ts";
import { signEd25519 } from "../../core/crypto/ed25519.ts";
import { canonicalStringify } from "../../shared/canonical.ts";
import { eventWithoutSignature, type SignupEvent } from "../../shared/events.ts";
import {
  appendLocalEvent,
  closeLocalStore,
  getNextNonce,
} from "../p2p_state.ts";
import { getEvents } from "../../core/ledger/events.ts";


const AGENT_INFO: Record<AgentType, { name: string; credDir: string; installHint: string; loginCmd: string; statusCmd: string[] }> = {
  claude: {
    name: "Claude Code",
    credDir: `${homedir()}/.claude`,
    installHint: "npm install -g @anthropic-ai/claude-code",
    loginCmd: "claude auth login",
    statusCmd: ["claude", "auth", "status"],
  },
  codex: {
    name: "Codex",
    credDir: `${homedir()}/.codex`,
    installHint: "npm install -g @openai/codex",
    loginCmd: "codex login",
    statusCmd: ["codex", "login", "status"],
  },
};

async function isBinaryInstalled(bin: string): Promise<boolean> {
  try {
    const proc = spawn([bin, "--version"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch { return false; }
}

async function isAgentLoggedIn(agent: AgentType): Promise<boolean> {
  try {
    const proc = spawn(AGENT_INFO[agent].statusCmd, { stdout: "ignore", stderr: "ignore" });
    if ((await proc.exited) === 0) return true;
  } catch { /* fall through to credDir check */ }
  try { return (await stat(AGENT_INFO[agent].credDir)).isDirectory(); } catch { return false; }
}

// Verifies the credentials actually used by the sandbox, not the host CLI
// login. For claude we probe the saved long-lived token against the
// Anthropic API (401/403 ⇒ expired or revoked). `claude auth status` is
// only a presence check — it returns logged-in for any well-formed string
// — so it can't be used here. For codex we ask its stored session whether
// it still authenticates.
export async function validateAgentCredentials(agent: AgentType): Promise<boolean> {
  if (agent === "claude") {
    const token = await loadAgentToken();
    if (!token || !token.startsWith("sk-ant-")) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: controller.signal,
      });
      if (res.status === 200) return true;
      if (res.status === 401 || res.status === 403) return false;
      // 5xx / other transient — don't block startup.
      return true;
    } catch {
      // Network failure — don't block startup.
      return true;
    } finally {
      clearTimeout(timer);
    }
  }
  if (agent === "codex") {
    const codexSessionDir = `${ASH_DIR}/codex-session`;
    try { await stat(`${codexSessionDir}/.codex/auth.json`); } catch { return false; }
    const safeEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: codexSessionDir,
    };
    try {
      const proc = spawn(["codex", "login", "status"], {
        stdout: "ignore", stderr: "ignore", env: safeEnv,
      });
      return (await proc.exited) === 0;
    } catch { return false; }
  }
  return false;
}

export async function ensureAgentLoggedIn(agent: AgentType): Promise<void> {
  const info = AGENT_INFO[agent];
  if (!(await isBinaryInstalled(agent))) {
    console.error(`\nerror: ${info.name} CLI is not installed.`);
    console.error(`  install: ${info.installHint}\n`);
    process.exit(2);
  }
  if (await isAgentLoggedIn(agent)) return;

  if (!process.stdin.isTTY) {
    console.error(`\nerror: ${info.name} is not logged in. Run: ${info.loginCmd}\n`);
    process.exit(2);
  }
  const yn = await confirm({ message: `${info.name} is not logged in. Log in now?`, default: false });
  if (!yn) {
    console.error(`\nerror: Login required. Run: ${info.loginCmd}\n`);
    process.exit(2);
  }
  const [cmd, ...args] = info.loginCmd.split(" ");
  const proc = spawn([cmd!, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  await proc.exited;
  if (!(await isAgentLoggedIn(agent))) {
    console.error(`\nerror: Login failed. Please run: ${info.loginCmd}\n`);
    process.exit(1);
  }
}

export async function refreshAgentCredentials(agent: AgentType): Promise<void> {
  if (agent === "claude") {
    console.log("\n  Generating a long-lived token for container use...\n");
    const proc = spawn(["claude", "setup-token"], {
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    await proc.exited;
    const token = (await input({ message: "Paste your token (starts with sk-ant-…)" })).trim();
    if (!token || !token.startsWith("sk-ant-")) {
      console.error("\nerror: Invalid token. Re-run `ash init` after `claude setup-token` succeeds.\n");
      process.exit(2);
    }
    await saveAgentToken(token);
    console.log("  Token saved.");
  } else if (agent === "codex") {
    console.log("\n  Creating a dedicated session for container use...\n");
    const codexSessionDir = `${ASH_DIR}/codex-session`;
    await mkdir(codexSessionDir, { recursive: true });
    const safeEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: codexSessionDir,
    };
    if (process.env.TERM) safeEnv.TERM = process.env.TERM;
    if (process.env.LANG) safeEnv.LANG = process.env.LANG;
    const proc = spawn(["codex", "login"], {
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
      env: safeEnv,
    });
    if ((await proc.exited) !== 0) {
      console.error("\nerror: Login failed. Try again.\n");
      process.exit(1);
    }
    try { await stat(`${codexSessionDir}/.codex/auth.json`); } catch {
      console.error("\nerror: Session not created.\n");
      process.exit(1);
    }
    console.log("  Session created.");
  }
}

export type AgentStatus = "valid" | "expired" | "not_configured";

export async function getAgentStatus(agent: AgentType): Promise<AgentStatus> {
  if (agent === "claude") {
    const token = await loadAgentToken();
    if (!token || !token.startsWith("sk-ant-")) return "not_configured";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) return "expired";
      return "valid";
    } catch {
      return "valid"; // network error — don't report as expired
    } finally {
      clearTimeout(timer);
    }
  }
  if (agent === "codex") {
    const codexSessionDir = `${ASH_DIR}/codex-session`;
    try { await stat(`${codexSessionDir}/.codex/auth.json`); } catch { return "not_configured"; }
    const safeEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: codexSessionDir,
    };
    try {
      const proc = spawn(["codex", "login", "status"], {
        stdout: "ignore", stderr: "ignore", env: safeEnv,
      });
      return (await proc.exited) === 0 ? "valid" : "expired";
    } catch { return "valid"; }
  }
  return "not_configured";
}

export async function selectAndSaveAgent(): Promise<void> {
  const agent = await select({
    message: "Which AI agent will you use?",
    choices: [
      { name: "Claude Code  (claude.ai account)", value: "claude" as const },
      { name: "Codex        (OpenAI account)",    value: "codex"  as const },
    ],
  });
  await ensureAgentLoggedIn(agent);
  await saveAgent(agent);
  await refreshAgentCredentials(agent);
  console.log(`\n  agent: ${AGENT_INFO[agent].name}`);
}

/**
 * Appends a SignupEvent to the user's Hypercore if one isn't already there.
 * The event is admin-watched to auto-issue the signup bonus (a MintEvent
 * signed by ADMIN_PUBKEY). Balance stays at 0 until the admin watcher picks
 * up the event — which only happens when a coordinator is online and has
 * replicated this user's core.
 */
async function ensureSignupEvent(
  pubHex: string,
  username: string,
): Promise<boolean> {
  const existing = await getEvents(pubHex);
  if (existing.some((e) => e.type === "signup")) return false;

  const { priv } = await loadIdentity();
  const rsa = await getOrCreateKeyPair(pubHex);
  const rsaPem = await exportPublicKeyPem(rsa.publicKey);

  const base = {
    type: "signup" as const,
    nonce: await getNextNonce(pubHex),
    timestamp: new Date().toISOString(),
    signature: "",
    username,
    ed25519_public_key: pubHex,
    rsa_public_key: rsaPem,
  };
  const sig = signEd25519(
    canonicalStringify(eventWithoutSignature(base as SignupEvent)),
    priv,
  );
  await appendLocalEvent(pubHex, { ...base, signature: sig });
  return true;
}

async function runInit(): Promise<void> {
  console.log("\nWelcome to ash!\n");

  const config = await loadConfig();
  let pubHex: string;
  let username: string;
  if (config.pubkey && config.username) {
    console.log(`  Identity already set up:  ${config.username}\n`);
    pubHex = config.pubkey;
    username = config.username;
  } else {
    username = (await input({
      message: "Choose a username",
      validate: (v) => /^[a-zA-Z0-9_-]{3,20}$/.test(v.trim()) || "3–20 chars: a-z, 0-9, _, -",
      default: config.username,
    })).trim().toLowerCase();

    // Generate Ed25519 (identity) + RSA (AES key exchange) keypairs.
    const identity = await getOrCreateIdentity();
    await getOrCreateKeyPair(identity.pubHex);
    await saveConfig({ username, pubkey: identity.pubHex });
    pubHex = identity.pubHex;

    console.log(`\n  username: ${username}`);
    console.log(`  pubkey:   ${identity.pubHex.slice(0, 16)}…\n`);
  }

  const wroteSignup = await ensureSignupEvent(pubHex, username);
  await closeLocalStore().catch(() => undefined);
  if (wroteSignup) {
    console.log(
      `  Signup recorded. Your signup bonus will be credited the next time\n` +
      `  you join the network while a coordinator is online.\n`,
    );
  }

  await selectAndSaveAgent();

  console.log("\n  Setting up environment...\n");
  await runSetup(false);

  console.log("\nDone. Run `ash` to get started.\n");
}

export const initCommand = new Command("init")
  .description("First-time setup: keypair, agent, environment")
  .action(async () => {
    try { await runInit(); }
    catch (err) {
      console.error(`\nerror: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });
