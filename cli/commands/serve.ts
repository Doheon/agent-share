/**
 * ash serve — P2P task acceptor.
 *
 * Listens on the Hyperswarm topic, claims the first task announcement that
 * arrives, runs the AI agent in a sandbox, returns the diff, and on approve
 * appends the cosigned EarnEvent to its local Hypercore log.
 */

import { Command } from "commander";
import { confirm } from "@inquirer/prompts";
import { writeSync } from "node:fs";
import {
  loadConfig,
  loadIdentity,
  loadModelTier,
} from "../client.ts";
import {
  loadPrivateKey,
  getOrCreateKeyPair,
} from "../../core/crypto/keypair.ts";
import { decryptAesKey, exportPublicKeyPem } from "../../core/crypto/rsa.ts";
import { unpackToDirectory } from "../../core/packaging/unpack.ts";
import { buildTaskAad } from "../../core/crypto/aes.ts";
import { runAgentInSandbox, CODEX_LAST_MESSAGE_FILE } from "../../core/sandbox/runner.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { initRepo, extractDiff } from "../../core/diff/extract.ts";
import { cleanupTask, ensureTaskDir } from "../../core/sandbox/cleanup.ts";
import {
  ensureAgentLoggedIn,
  refreshAgentCredentials,
  validateAgentCredentials,
} from "./init.ts";
import { ensureInitialized, NotInitializedError } from "../guard.ts";
import { modelToAgent } from "../../shared/types.ts";
import { MODEL_CREDITS, splitFee } from "../../shared/policy.ts";
import { CLIENT_VERSION } from "../../shared/protocol.ts";
import { AshSwarm, type SwarmPeer } from "../../core/p2p/swarm.ts";
import type { P2PMessage } from "../../core/p2p/messages.ts";
import {
  appendCheckpointEvent,
  closeLocalStore,
  getLedgerCoreKey,
  getLocalBalance,
  getNextNonce,
  getRemotePeerBalance,
} from "../p2p_state.ts";
import { getAdminMintsFor, getEvents } from "../../core/ledger/events.ts";
import { registerPeerLedgerKey, getPeerLedgerKey } from "../../core/ledger/peer_keys.ts";
import { ADMIN_PUBKEY } from "../../shared/constants.ts";
import { createLedgerReplicationSwarm } from "../ledger_replication.ts";
import { signEd25519, verifyEd25519, rawHexToPublicKey } from "../../core/crypto/ed25519.ts";
// signEd25519 is used in the cosigner-side mine:claim handler (~line 506);
// kept here so the cosign signing path doesn't have to re-import it.
import { canonicalStringify } from "../../shared/canonical.ts";
import { checkpointPayload } from "../../shared/events.ts";
import { fetchPR, fetchPRReviews, fetchIssue, ASH_REPO } from "../../core/github/client.ts";
import { getRuntime } from "../../core/sandbox/runtime.ts";

const IS_TTY = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const _a = (c: string) => IS_TTY ? `\x1b[${c}m` : "";
const R = _a("0"), B = _a("1"), D = _a("2");
const GR = _a("32"), YL = _a("33"), RD = _a("31"), CY = _a("36");

const enc = new TextEncoder();
const out = (s: string) => writeSync(1, enc.encode(s));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinTimer: ReturnType<typeof setInterval> | null = null;

function startSpin(label = "waiting for tasks"): void {
  if (spinTimer || !IS_TTY) return;
  const t0 = Date.now();
  let i = 0;
  spinTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - t0) / 1000);
    out(`\r  ${D}${CY}${SPIN[i++ % SPIN.length]}${R}  ${D}${label}  ·  ${secs}s${R}\x1b[K`);
  }, 80);
}
function stopSpin(): void {
  if (!spinTimer) return;
  clearInterval(spinTimer);
  spinTimer = null;
  if (IS_TTY) out("\r\x1b[K");
}

export class AuthError extends Error {}
const AUTH_PATTERNS = [/not (logged in|authenticated)/i, /invalid.?api.?key/i, /\b401\b/, /\bunauthorized\b/i];
const isAuthLine = (s: string) => AUTH_PATTERNS.some((p) => p.test(s));

function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

export interface ActiveTask {
  taskId: string;
  requesterPubkey: string;
  requesterLedgerKey: string;
  prompt: string;
  model: string;
  blobSize?: number;
  blobIvB64?: string;
  encryptedAesKeyB64?: string;
  blobB64?: string;
  blobChunks?: string[];
  onBlobChunk?: (received: number, total: number) => void;
  peer: SwarmPeer;
  resolveBlob?: () => void;
  resolveMatch?: () => void;
  resolveSpend?: (evt: import("../../shared/events.ts").SpendCheckpointEvent | null) => void;
  resolveEarn?: (evt: { acceptor_checkpoint_cosig: string; acceptor_earn_checkpoint: import("../../shared/events.ts").EarnCheckpointEvent } | null) => void;
}

export async function processTask(
  active: ActiveTask,
  myPub: string,
  modelTier: string,
  logger: (s: string) => void = out,
): Promise<{ earned: number }> {
  const agent = modelToAgent(modelTier);
  let earned = 0;

  // Refuse work for tiers that aren't in MODEL_CREDITS — otherwise
  // `MODEL_CREDITS[modelTier] ?? 0` would yield 0 for both `fullCredits`
  // and `halfCredits`, `validAmount(0)` would be true, and the
  // acceptor would do the work for free. The peer-side `model !== opts.modelTier`
  // filter normally prevents this from being exploitable across stock
  // builds, but a forked client could match on a custom tier string.
  if (MODEL_CREDITS[modelTier] === undefined) {
    logger(`  ${YL}⚠${R}  unknown model tier '${modelTier}' — rejecting task\n`);
    active.peer.send({ type: "task:settle", task_id: active.taskId, action: "reject" });
    throw new Error(`unknown model tier: ${modelTier}`);
  }

  // Re-validate agent credentials at the start of every task. Tokens can
  // expire mid-session; without this check the acceptor would burn the
  // full sandbox timeout (25min default) before failing with an auth
  // error. Reject the requester cleanly so they can pick another peer.
  if (!(await validateAgentCredentials(agent))) {
    logger(`  ${YL}⚠${R}  ${agent} credentials expired — rejecting task\n`);
    active.peer.send({ type: "task:settle", task_id: active.taskId, action: "reject" });
    throw new AuthError(`${agent} credentials are no longer valid`);
  }

  // Promises that resolve immediately if the message already arrived before processTask started.
  const matchPromise = new Promise<void>((r) => {
    if (active.encryptedAesKeyB64 && active.blobIvB64) r();
    else active.resolveMatch = r;
  });

  // Wait for the requester's task:match (with the encrypted AES key + IV).
  logger(`  ${D}waiting for AES key…${R}\n`);
  await Promise.race([matchPromise, sleep(20_000)]);
  if (active.encryptedAesKeyB64 === undefined || active.blobIvB64 === undefined) {
    throw new Error("requester did not deliver AES key in time");
  }

  // Ask for the blob.
  active.peer.send({ type: "task:blob_request", task_id: active.taskId });
  const blobPromise = new Promise<void>((r) => {
    if (active.blobB64) r();
    else active.resolveBlob = r;
  });
  const blobSizeMB = active.blobSize ? (active.blobSize / 1024 / 1024).toFixed(1) : "?";
  logger(`  receiving blob (${blobSizeMB} MB)…\n`);

  // Show progress bar as chunks arrive.
  const BAR_WIDTH = 20;
  let lastLoggedPct = -1;
  active.onBlobChunk = (received, total) => {
    const pct = Math.floor(received / total * 100);
    if (pct >= lastLoggedPct + 25 || received === total) {
      lastLoggedPct = pct;
      const filled = Math.round(BAR_WIDTH * received / total);
      const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
      const rcvMB = (received / total * (active.blobSize ?? 0) / 1024 / 1024).toFixed(1);
      logger(`  [${bar}] ${pct}%  ${rcvMB}/${blobSizeMB} MB\n`);
    }
  };

  await Promise.race([blobPromise, sleep(300_000)]);
  active.onBlobChunk = undefined;
  if (!active.blobB64) {
    active.peer.send({ type: "task:cancel", task_id: active.taskId });
    throw new Error(`blob transfer timed out after 5 minutes (${blobSizeMB} MB)`);
  }

  // Decrypt and unpack.
  const ciphertext = new Uint8Array(Buffer.from(active.blobB64, "base64"));
  const iv = new Uint8Array(Buffer.from(active.blobIvB64, "base64"));
  const rsaPriv = await loadPrivateKey(myPub);
  const aesKeyRaw = await decryptAesKey(active.encryptedAesKeyB64, rsaPriv);

  const workDir = await ensureTaskDir(active.taskId);
  // Bind AAD to (taskId, requesterPubkey) — matches the requester's pack.
  // Any ciphertext substitution from another concurrent task will fail
  // authenticated decryption here.
  const aad = buildTaskAad(active.taskId, active.requesterPubkey);
  active.peer.send({ type: "task:log", task_id: active.taskId, line: "unpacking workspace…" });
  await unpackToDirectory(ciphertext, aesKeyRaw, iv, workDir, aad);
  await initRepo(workDir);
  active.peer.send({ type: "task:log", task_id: active.taskId, line: "starting agent…" });

  // Run the AI agent in the sandbox. For codex we keep stdout on the acceptor
  // side (banner, streaming delta, token footer, prompt echo) and forward
  // only the final assistant message — written to .ash_last.md by
  // `--output-last-message` — so the requester gets a clean chat transcript.
  // Claude has no equivalent flag; its stream is still forwarded line-by-line.
  let authHit = false;
  const forwardLogs = agent !== "codex";
  // Each agent only needs egress to its own provider. Mixing them would
  // waste an outbound allowance for whichever isn't running.
  const allowedHosts = agent === "codex"
    ? ["api.openai.com", "chatgpt.com"]
    : ["api.anthropic.com"];
  const { exitCode } = await runAgentInSandbox({
    taskDir: workDir,
    agent,
    prompt: active.prompt,
    allowedHosts,
    onLog: (line, historyOnly) => {
      if (!historyOnly) logger(`  ${D}${line}${R}\n`);
      if (forwardLogs) {
        active.peer.send({ type: "task:log", task_id: active.taskId, line, history_only: historyOnly });
      }
      if (isAuthLine(line)) authHit = true;
    },
  });
  logger(`\n  ${D}exit code: ${exitCode}${R}\n`);

  if (agent === "codex" && !authHit) {
    try {
      const raw = await readFile(join(workDir, CODEX_LAST_MESSAGE_FILE), "utf8");
      const trimmed = raw.trim();
      if (trimmed) {
        for (const line of trimmed.split("\n")) {
          active.peer.send({ type: "task:log", task_id: active.taskId, line });
        }
      }
    } catch { /* file missing — codex exited before writing; requester just won't see a reply */ }
  }

  // Extract diff & ship it. If auth failed, send empty patch so the requester rejects cleanly.
  const diff = await extractDiff(workDir, logger);
  const patch = authHit ? "" : diff.patch;
  active.peer.send({ type: "task:diff", task_id: active.taskId, patch });
  if (authHit) {
    logger(`  ${YL}⚠${R}  auth failed — sending empty diff\n`);
  } else if (diff.patch) {
    logger(`  ${GR}✓${R}  ${diff.filesChanged} files changed (+${diff.insertions}/-${diff.deletions})\n`);
  } else {
    logger(`  ${YL}⚠${R}  No changes.\n`);
  }

  // Wait for the requester's spend:cosign (SpendCheckpointEvent), then validate and drive the settle.
  const spendPromise = new Promise<import("../../shared/events.ts").SpendCheckpointEvent | null>((resolve) => {
    let done = false;
    const settle = (evt: import("../../shared/events.ts").SpendCheckpointEvent | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(evt);
    };
    active.resolveSpend = settle;
    const t = setTimeout(() => settle(null), 120_000);
  });
  const spend = await spendPromise;

  // Requester pays full on apply, half on reject / no-diff / timeout.
  // Auth failures (authHit) are never charged — see !authHit below.
  const fullCredits = MODEL_CREDITS[modelTier] ?? 0;
  const halfCredits = Math.floor(fullCredits / 2);
  const validAmount = (n: number) => n === fullCredits || n === halfCredits;

  // Verify the requester's signature over the checkpoint payload (excludes
  // both `signature` and `sig_counterparty` so the payload is order-invariant).
  let prevRequesterBalance = 0;
  let prevRequesterCoreLength = -1;
  let balanceLookupOk = false;
  let spendOk = false;
  if (!authHit && spend !== null) {
    try {
      const info = await getRemotePeerBalance(active.requesterLedgerKey, active.requesterPubkey);
      prevRequesterBalance = info.balance;
      prevRequesterCoreLength = info.coreLength;
      balanceLookupOk = true;
    } catch { /* balance check failure → balanceLookupOk stays false, spendOk stays false */ }
    spendOk =
      balanceLookupOk &&
      spend.balance >= 0 &&
      spend.task_id === active.taskId &&
      validAmount(spend.amount) &&
      spend.counterparty_pubkey === myPub &&
      spend.owner_pubkey === active.requesterPubkey &&
      // Strict equality: nonce must match core.length exactly at replication time.
      // Replication lag is a liveness concern (retry), not a security tolerance.
      // Using >= would let a requester pre-sign a future nonce and replay it later.
      //
      // NOTE (not a bug): coreLength cannot be N+1 when spend.nonce=N in normal usage.
      // The proposed spend_checkpoint has NOT been appended yet when spend:cosign is sent —
      // the requester appends only after receiving our approve. The per-pubkey mutex prevents
      // concurrent appends in the same process; cross-process writes are covered by the
      // corestore lock. So prevRequesterCoreLength === spend.nonce in the honest path.
      spend.nonce === prevRequesterCoreLength &&
      (prevRequesterBalance - spend.amount) === spend.balance &&
      verifyEd25519(
        canonicalStringify(checkpointPayload(spend)),
        spend.signature,
        rawHexToPublicKey(active.requesterPubkey),
      );
  }

  if (!spendOk) {
    if (!authHit) {
      if (spend === null) {
        logger(`  ${D}requester declined — no credits charged${R}\n`);
      } else {
        logger(`  ${YL}⚠${R}  spend:cosign invalid — rejecting\n`);
      }
    }
    active.peer.send({ type: "task:settle", task_id: active.taskId, action: "reject" });
    logger(`  ${D}settle: reject${R}\n`);
    await cleanupTask(active.taskId);
    if (authHit) throw new AuthError("session expired");
    return { earned };
  }

  // Cosign the requester's SpendCheckpoint.
  const { priv: edPriv } = await loadIdentity();
  const requesterCosig = signEd25519(canonicalStringify(checkpointPayload(spend!)), edPriv);

  // Build, send, and append our EarnCheckpoint inside the per-pubkey mutex so that
  // balance + nonce are read atomically with the append. Holding the lock across the
  // network wait serialises earn settlements for this acceptor — the correct behaviour
  // when two tasks complete concurrently (prevents both from stamping the same balance).
  const expectedEarn = splitFee(spend!.amount).acceptor;
  await appendCheckpointEvent(myPub, async (earnNonce, myCurrentBalance) => {
    const earnCheckpointBase: Omit<import("../../shared/events.ts").EarnCheckpointEvent, "signature"> = {
      type: "earn_checkpoint",
      nonce: earnNonce,
      timestamp: new Date().toISOString(),
      balance: myCurrentBalance + expectedEarn,
      task_id: active.taskId,
      amount: expectedEarn,
      counterparty_pubkey: active.requesterPubkey,
      owner_pubkey: myPub,
      sig_counterparty: "",
    };
    const earnCheckpointSig = signEd25519(
      canonicalStringify(checkpointPayload(earnCheckpointBase as import("../../shared/events.ts").EarnCheckpointEvent)),
      edPriv,
    );
    const earnCheckpoint: import("../../shared/events.ts").EarnCheckpointEvent = {
      ...earnCheckpointBase,
      signature: earnCheckpointSig,
    };

    active.peer.send({
      type: "task:settle",
      task_id: active.taskId,
      action: "approve",
      requester_checkpoint_cosig: requesterCosig,
      acceptor_earn_checkpoint: earnCheckpoint,
    });
    logger(`  ${D}settle: approve${R}\n`);

    const earnMsg = await new Promise<{ acceptor_checkpoint_cosig: string; acceptor_earn_checkpoint: import("../../shared/events.ts").EarnCheckpointEvent } | null>((resolve) => {
      let done = false;
      const settle = (evt: { acceptor_checkpoint_cosig: string; acceptor_earn_checkpoint: import("../../shared/events.ts").EarnCheckpointEvent } | null) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(evt);
      };
      active.resolveEarn = settle;
      const t = setTimeout(() => settle(null), 30_000);
    });

    if (!earnMsg) throw new Error("no-earn-cosign");

    const earnCosigOk = verifyEd25519(
      canonicalStringify(checkpointPayload(earnCheckpoint)),
      earnMsg.acceptor_checkpoint_cosig,
      rawHexToPublicKey(active.requesterPubkey),
    );
    if (!earnCosigOk) throw new Error("earn-cosig-invalid");

    // earned and success log set only after appendEvent below succeeds (torn-append fix).
    return { ...earnCheckpoint, sig_counterparty: earnMsg.acceptor_checkpoint_cosig };
  }).then(() => {
    earned = expectedEarn;
    logger(`  ${GR}✓${R}  earn cosigned · +${expectedEarn}cr\n`);
  }).catch((err: unknown) => {
    const msg = (err as Error).message;
    if (msg === "no-earn-cosign") {
      logger(`  ${YL}⚠${R}  no earn cosign in 30s — credit not awarded (requester dropped after approve)\n`);
    } else if (msg === "earn-cosig-invalid") {
      logger(`  ${YL}⚠${R}  earn:cosign invalid — skipping\n`);
    } else {
      logger(`  ${YL}⚠${R}  failed to append earn: ${msg}\n`);
    }
  });

  await cleanupTask(active.taskId);
  return { earned };
}

export async function runServeAi(opts: { count: number; modelTier: string; allowSelf?: boolean }): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.pubkey || !cfg.username) {
    out("\nerror: not initialized. Run: ash init\n\n");
    process.exit(1);
  }
  const myPub: string = cfg.pubkey;
  const agent = modelToAgent(opts.modelTier);

  // Per-peer rate limit on mine:claim verification — each call burns a
  // GitHub authenticated request, capped 5000/hr. 10 claims/min/peer
  // is generous for legitimate miners and survives a full hour of
  // sustained spam from a single hostile peer.
  const claimsByPeer = new Map<string, { count: number; windowStart: number }>();
  const seenMineClaimIds = new Set<string>();
  const allowMineClaim = (pubkey: string): boolean => {
    const now = Date.now();
    const slot = claimsByPeer.get(pubkey);
    if (!slot || now - slot.windowStart > 60_000) {
      claimsByPeer.set(pubkey, { count: 1, windowStart: now });
      return true;
    }
    if (slot.count >= 10) return false;
    slot.count++;
    return true;
  };

  // The sandbox uses a separately-stored long-lived token (claude) or an
  // isolated codex session, not the host CLI login. Validate that token /
  // session against the real service before joining the swarm — otherwise we
  // would silently advertise availability and fail mid-task when the token
  // has expired (Claude's setup-token tokens expire sooner than a year).
  if (!(await validateAgentCredentials(agent))) {
    out(`\n  ${YL}⚠${R}  ${agent} credentials missing or expired.\n`);
    if (!process.stdin.isTTY) {
      console.error(`\n  Refresh them with: ash login\n`);
      process.exit(2);
    }
    const yn = await confirm({ message: "Refresh credentials now?", default: true });
    if (!yn) { out("\n  Aborted.\n\n"); process.exit(1); }
    await ensureAgentLoggedIn(agent);
    await refreshAgentCredentials(agent);
    if (!(await validateAgentCredentials(agent))) {
      out(`\n  ${RD}✗${R}  Credentials still invalid. Re-run: ash init\n\n`);
      process.exit(1);
    }
  }

  // Verify container runtime before joining the swarm so users get a clear
  // error immediately instead of a cryptic sandbox failure mid-task.
  try {
    await getRuntime();
  } catch {
    out(`\n  ${RD}✗${R}  No container runtime found. Run: ash setup\n\n`);
    process.exit(1);
  }

  // Make sure we have an RSA keypair so we can advertise our pubkey.
  const rsa = await getOrCreateKeyPair(myPub);
  const rsaPubPem = await exportPublicKeyPem(rsa.publicKey);

  const balance = (await getLocalBalance(myPub)).balance;
  out(`\n  ${B}${CY}ash serve${R}  ${D}· ${opts.count} tasks  · ${opts.modelTier}  · ${balance}cr${R}\n`);
  if (opts.allowSelf) {
    out(`  ${YL}⚠${R}  --allow-self enabled — you will accept and charge yourself\n`);
  }
  // Container runtime exposure is materially different on Linux (rootless
  // podman) vs macOS/Windows (Docker bridge → host LAN). The bridge case
  // is a real risk worth surfacing every time so users on cloud instances
  // notice; the podman case is silent.
  try {
    const runtime = await getRuntime();
    if (runtime === "docker") {
      out(`  ${YL}⚠${R}  Docker network bridge can reach your host LAN and IP-only\n`);
      out(`     metadata endpoints (e.g. 169.254.169.254). Run on a machine\n`);
      out(`     without sensitive LAN neighbours, or use rootless podman.\n`);
    }
  } catch { /* runtime check fires again later */ }
  out("\n");

  const { priv: myPriv } = await loadIdentity();

  // Join the swarm first so we are discoverable while checking agent credentials.
  const swarm = new AshSwarm();
  try {
    await swarm.join(myPriv, myPub);
  } catch (err) {
    console.error(`\n  Failed to join P2P network: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Attach Corestore replication to every Hyperswarm connection so that
  // remote event Hypercores are propagated to all peers (global ledger).
  // Uses a separate Hyperswarm join on LEDGER_TOPIC so the stream is not
  // shared with the task JSON protocol.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let replicationSwarm: any = null;
  try {
    replicationSwarm = await createLedgerReplicationSwarm();
  } catch {
    // Ledger replication failure is non-fatal — tasks still work.
  }

  let busy = false;
  let active: ActiveTask | null = null;
  let completed = 0;
  let stop = false;

  const cleanupAndExit = async (code: number) => {
    stopSpin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (replicationSwarm) await (replicationSwarm as any).destroy().catch(() => {});
    await swarm.destroy();
    await closeLocalStore();
    process.exit(code);
  };
  process.on("SIGINT", () => { out("\n  Interrupted\n\n"); cleanupAndExit(0); });
  process.on("SIGTERM", () => { out("\n  Terminated\n\n"); cleanupAndExit(0); });

  swarm.onConnect(async () => {
    const ledgerCoreKey = await getLedgerCoreKey(myPub).catch(() => undefined);
    swarm.broadcast({
      type: "peer:info",
      pubkey: myPub,
      username: cfg.username!,
      model_tier: opts.modelTier,
      ledger_core_key: ledgerCoreKey,
    });
  });

  swarm.onMessage(async (peer, msg) => {
    // Cache any advertised ledger core key so later balance replays can
    // cross-ref this peer's log (bug fix: earn events were silently dropped
    // because `getUserCore(pubkey)` returned an empty local stub).
    if (msg.type === "peer:info") {
      // Only trust the ledger key when peer:info matches the
      // handshake-verified identity. Otherwise a malicious peer could
      // poison our cache with a fake mapping for someone else's pubkey
      // (peer_keys.ts is first-write-wins, so the bad entry would
      // shadow the legitimate one indefinitely).
      if (msg.pubkey === peer.pubkey) {
        registerPeerLedgerKey(msg.pubkey, msg.ledger_core_key).catch(() => undefined);
      }
      return;
    }
    if (active && active.peer.id === peer.id) {
      switch (msg.type) {
        case "task:match":
          if (msg.task_id !== active.taskId) return;
          active.encryptedAesKeyB64 = msg.encrypted_aes_key;
          active.blobIvB64 = msg.blob_iv;
          active.resolveMatch?.();
          return;
        case "task:blob":
          if (msg.task_id !== active.taskId) return;
          active.blobB64 = msg.data;
          active.resolveBlob?.();
          return;
        case "task:blob_chunk": {
          if (msg.task_id !== active.taskId) return;
          if (!active.blobChunks) active.blobChunks = new Array(msg.total);
          active.blobChunks[msg.index] = msg.data;
          const received = active.blobChunks.filter((s) => s !== undefined).length;
          active.onBlobChunk?.(received, msg.total);
          if (received >= msg.total) {
            active.blobB64 = active.blobChunks.join("");
            active.resolveBlob?.();
          }
          return;
        }
        case "spend:cosign":
          if (msg.task_id !== active.taskId) return;
          active.resolveSpend?.(msg.spend_checkpoint);
          return;
        case "earn:cosign":
          if (msg.task_id !== active.taskId) return;
          active.resolveEarn?.({ acceptor_checkpoint_cosig: msg.acceptor_checkpoint_cosig, acceptor_earn_checkpoint: msg.acceptor_earn_checkpoint });
          return;
        case "task:cancel":
          if (msg.task_id !== active.taskId) return;
          active.resolveSpend?.(null);
          return;
      }
      return;
    }

    // Verify mine:claim from any peer and send back cosign signature.
    if (msg.type === "mine:claim") {
      if (msg.claimant_pubkey !== peer.pubkey) return; // reject spoofed claimant identity
      if (msg.claimant_pubkey === myPub) return; // don't self-cosign
      // Rate-limit per claimant_pubkey: each `fetchPR`/`fetchIssue`
      // call below burns a slot of the user's GitHub authenticated
      // hourly cap (5,000/hr). Without this a hostile peer could
      // sustain ~80 claims/sec and exhaust the cap, denying both
      // mine and serve flows that depend on the same token.
      if (!allowMineClaim(peer.pubkey)) return;
      // Dedup by claim_id so the same claim cannot be replayed to
      // amplify the verification load.
      if (seenMineClaimIds.has(msg.claim_id)) return;
      seenMineClaimIds.add(msg.claim_id);
      const ghToken = cfg.githubToken ?? process.env.GITHUB_TOKEN;
      if (!ghToken) return; // can't verify without a token

      try {
        // Parse github_ref: "<type>:<repo>:<num>", except "close-rec:<sub>:<repo>:<num>".
        const parts = msg.github_ref.split(":");
        const refType = parts[0];

        let verified = false;
        if (refType === "close-rec") {
          const sub = parts[1];
          const repo = parts[2] ?? ASH_REPO;
          const refNum = parseInt(parts[3] ?? "0", 10);
          if (sub === "pr") {
            const pr = await fetchPR(repo, refNum, ghToken).catch(() => null);
            verified = !!pr;
          } else if (sub === "issue") {
            const issue = await fetchIssue(repo, refNum, ghToken).catch(() => null);
            verified = !!issue;
          }
        } else {
          const repo = parts[1] ?? ASH_REPO;
          const refNum = parseInt(parts[2] ?? "0", 10);
          if (refType === "pr") {
            const pr = await fetchPR(repo, refNum, ghToken).catch(() => null);
            verified = !!pr && (pr.state === "open" || pr.merged);
          } else if (refType === "review") {
            const reviews = await fetchPRReviews(repo, refNum, ghToken).catch(() => []);
            verified = reviews.length > 0;
          } else if (refType === "approve") {
            const reviews = await fetchPRReviews(repo, refNum, ghToken).catch(() => []);
            verified = reviews.some((r) => r.state === "APPROVED");
          } else if (refType === "fix") {
            const pr = await fetchPR(repo, refNum, ghToken).catch(() => null);
            verified = !!pr;
          } else if (refType === "issue") {
            const issue = await fetchIssue(repo, refNum, ghToken).catch(() => null);
            verified = !!issue && issue.state === "open";
          }
        }

        if (!verified) return;

        const taskSigPayload = canonicalStringify({
          task_id: msg.task_id,
          amount: msg.amount,
          claimant_pubkey: msg.claimant_pubkey,
          action: "earn",
        });
        const cosignerTaskSig = signEd25519(taskSigPayload, myPriv);

        peer.send({
          type: "mine:cosign",
          claim_id: msg.claim_id,
          cosigner_pubkey: myPub,
          cosigner_task_signature: cosignerTaskSig,
        });
        out(`  ${GR}✓${R}  cosigned mine:claim for ${msg.claimant_pubkey.slice(0, 8)}…\n`);
      } catch {
        // Verification errors are non-fatal — just don't cosign.
      }
      return;
    }

    // Not currently active — only consider task:announce.
    if (msg.type !== "task:announce") return;
    if (busy || stop) return;
    if (msg.requester_pubkey !== peer.pubkey) return; // reject spoofed requester identity
    if (msg.requester_pubkey === myPub && !opts.allowSelf) return;
    if (msg.model !== opts.modelTier) return;

    const expectedCost = MODEL_CREDITS[msg.model] ?? 0;
    if (msg.credit_cost !== undefined && msg.credit_cost !== expectedCost) {
      const theirVer = peer.app_version ?? "unknown";
      const myVer = CLIENT_VERSION;
      const needsUpdate = semverGt(myVer, theirVer) ? `requester (${theirVer})` : `acceptor (${myVer})`;
      out(`  ${D}skip: price mismatch — requester expects ${msg.credit_cost}cr, we require ${expectedCost}cr · ${needsUpdate} needs update${R}\n`);
      peer.send({ type: "task:price_mismatch", task_id: msg.task_id, acceptor_app_version: myVer, expected_cost: expectedCost });
      return;
    }

    if (!msg.requester_ledger_key) {
      out(`  ${D}skip: ${msg.requester_pubkey.slice(0, 8)} missing ledger key${R}\n`);
      return;
    }
    // Persist the mapping before verifying balance — verifyEarnCrossRef at
    // replay time will look this up to open the requester's real core.
    await registerPeerLedgerKey(msg.requester_pubkey, msg.requester_ledger_key).catch(() => undefined);
    // Retry balance check up to 3 times with 3s spacing to handle DHT replication lag.
    // On localhost the LEDGER_TOPIC connection may not be established when the first
    // task:announce arrives, causing core.update() to return 0 blocks prematurely.
    let requesterBalance = 0;
    let balanceVerified = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await getRemotePeerBalance(msg.requester_ledger_key, msg.requester_pubkey);
        requesterBalance = result.balance;
        if (requesterBalance >= expectedCost) { balanceVerified = true; break; }
        if (attempt < 2) {
          out(`  ${D}balance check attempt ${attempt + 1}: ${requesterBalance}cr < ${expectedCost}cr — retrying in 3s…${R}\n`);
          await sleep(3000);
        }
      } catch (err) {
        if (attempt === 2) {
          console.error(`[warn] Could not verify requester balance: ${err}. Rejecting task.`);
          return;
        }
        await sleep(3000);
      }
    }
    if (!balanceVerified) {
      out(`  ${D}skip: ${msg.requester_pubkey.slice(0, 8)} has insufficient credits (${requesterBalance} < ${expectedCost})${R}\n`);
      return;
    }

    busy = true;
    stopSpin();
    out(`\n  ${B}[${completed + 1}/${opts.count}]${R} ${msg.prompt.slice(0, 60)}\n`);
    out(`  ${D}${"─".repeat(54)}${R}\n`);

    // Claim the task with our next nonce so the requester can co-sign earns
    // against the right slot in our log.
    let myNextNonce: number;
    try {
      myNextNonce = await getNextNonce(myPub);
    } catch (e) {
      busy = false;
      return;
    }
    const myLedgerKey = await getLedgerCoreKey(myPub).catch(() => undefined);
    const myAdminCoreKey = ADMIN_PUBKEY
      ? await getLedgerCoreKey(ADMIN_PUBKEY).catch(() => undefined)
      : undefined;
    const myAdminMints = ADMIN_PUBKEY
      ? await getAdminMintsFor(myPub).catch(() => [])
      : [];
    // Collect admin mints for every counterparty referenced in our earn events
    // so the requester can verify cross-refs without touching their local admin
    // core (which may differ from ours and skew the balance computation).
    // Mine-style earns (task_id starts with "github:") don't need this — they
    // use a different cross-ref path that doesn't gate on admin mint status.
    let counterpartyAdminMints: unknown[] = [];
    let counterpartyLedgerKeys: Record<string, string> = {};
    if (ADMIN_PUBKEY) {
      try {
        const events = await getEvents(myPub);
        const counterparties = new Set<string>();
        for (const ev of events) {
          if (ev.type === "earn" && !ev.task_id.startsWith("github:") && ev.counterparty_pubkey !== ADMIN_PUBKEY) {
            counterparties.add(ev.counterparty_pubkey);
          }
        }
        const mintArrays = await Promise.all(
          [...counterparties].map((cp) => getAdminMintsFor(cp).catch(() => [])),
        );
        counterpartyAdminMints = mintArrays.flat();
        // Send our authoritative pubkey -> ledger_core_key mapping for every
        // counterparty referenced in our earns. The requester's local cache may
        // be stale (peer rotated cores) — using ours ensures both sides open
        // the same Hypercore for cross-ref, making balance computation match.
        const cps = [...counterparties];
        const keys = await Promise.all(cps.map((cp) => getPeerLedgerKey(cp).catch(() => undefined)));
        for (let i = 0; i < cps.length; i++) {
          const k = keys[i];
          if (k) counterpartyLedgerKeys[cps[i]] = k;
        }
      } catch { /* non-fatal — falls back to local admin core on requester */ }
    }
    const claim: P2PMessage = {
      type: "task:claim",
      task_id: msg.task_id,
      acceptor_pubkey: myPub,
      rsa_public_key: rsaPubPem,
      next_nonce: myNextNonce,
      acceptor_ledger_key: myLedgerKey,
      ...(myAdminCoreKey ? { admin_core_key: myAdminCoreKey } : {}),
      ...(myAdminMints.length > 0 ? { admin_mints: myAdminMints } : {}),
      ...(counterpartyAdminMints.length > 0 ? { counterparty_admin_mints: counterpartyAdminMints } : {}),
      ...(Object.keys(counterpartyLedgerKeys).length > 0 ? { counterparty_ledger_keys: counterpartyLedgerKeys } : {}),
    };
    peer.send(claim);

    active = {
      taskId: msg.task_id,
      requesterPubkey: msg.requester_pubkey,
      requesterLedgerKey: msg.requester_ledger_key,
      prompt: msg.prompt,
      model: msg.model,
      blobSize: msg.blob_size,
      peer,
    };

    try {
      await ensureAgentLoggedIn(agent);
      await processTask(active, myPub, opts.modelTier);
      completed++;
      const newBal = (await getLocalBalance(myPub)).balance;
      out(`  ${D}${"─".repeat(54)}${R}\n`);
      out(`  ${GR}✓${R}  done  ${D}· balance: ${newBal}cr${R}\n`);
    } catch (err) {
      if (err instanceof AuthError) {
        out(`\n  ${RD}✗${R}  ${opts.modelTier} session expired.\n`);
        const yn = await confirm({ message: "Log in again now?", default: false });
        if (!yn) { out(`\n  Stopped.\n\n`); await cleanupAndExit(1); return; }
        await ensureAgentLoggedIn(agent);
        await refreshAgentCredentials(agent);
        out(`\n  Credentials refreshed. Continuing...\n\n`);
      } else {
        out(`  ${YL}⚠${R}  ${(err as Error).message}\n`);
      }
    } finally {
      active = null;
      busy = false;
      if (completed < opts.count) startSpin();
    }

    if (completed >= opts.count) {
      stop = true;
      out(`\n  ${GR}✓${R}  Done: ${completed} tasks processed\n\n`);
      await cleanupAndExit(0);
    }
  });

  startSpin();

  // Block forever — work happens inside the message handler.
  await new Promise<void>(() => { /* never resolves; SIGINT exits */ });
}

export const serveCommand = new Command("serve")
  .description("Accept and process P2P tasks (earn credits)")
  .option("-n, --count <count>", "Number of tasks to process", (v) => parseInt(v), 10)
  .option("--model <tier>", "Model tier to serve (overrides saved config)")
  .option("--allow-self", "Allow serving your own tasks (for local testing)")
  .action(async (options) => {
    try { await ensureInitialized(); }
    catch (err) {
      if (err instanceof NotInitializedError) {
        console.error(`\nerror: ${err.reason}\n  → ${err.hint}\n`);
        process.exit(2);
      }
      throw err;
    }
    const modelTier = options.model ?? await loadModelTier();
    await runServeAi({ count: options.count, modelTier, allowSelf: options.allowSelf });
  });
