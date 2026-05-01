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
import { AshSwarm, type SwarmPeer } from "../../core/p2p/swarm.ts";
import type { P2PMessage } from "../../core/p2p/messages.ts";
import {
  appendLocalEvent,
  closeLocalStore,
  getLedgerCoreKey,
  getLocalBalance,
  getNextNonce,
  getRemotePeerBalance,
} from "../p2p_state.ts";
import { getCorestore } from "../../core/ledger/store.ts";
import { registerPeerLedgerKey } from "../../core/ledger/peer_keys.ts";
import { LEDGER_TOPIC } from "../../shared/constants.ts";
import { signEd25519, verifyEd25519, rawHexToPublicKey } from "../../core/crypto/ed25519.ts";
// signEd25519 is used in the cosigner-side mine:claim handler (~line 506);
// kept here so the cosign signing path doesn't have to re-import it.
import { canonicalStringify } from "../../shared/canonical.ts";
import { eventWithoutSignature } from "../../shared/events.ts";
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

export interface ActiveTask {
  taskId: string;
  requesterPubkey: string;
  prompt: string;
  model: string;
  blobIvB64?: string;
  encryptedAesKeyB64?: string;
  blobB64?: string;
  peer: SwarmPeer;
  resolveBlob?: () => void;
  resolveMatch?: () => void;
  resolveSpend?: (evt: import("../../shared/events.ts").SpendEvent | null) => void;
  resolveEarn?: (evt: import("../../shared/events.ts").EarnEvent) => void;
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
  await Promise.race([blobPromise, sleep(60_000)]);
  if (!active.blobB64) throw new Error("requester did not deliver blob");

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
  await unpackToDirectory(ciphertext, aesKeyRaw, iv, workDir, aad);
  await initRepo(workDir);

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
    onLog: (line) => {
      logger(`  ${D}${line}${R}\n`);
      if (forwardLogs) {
        active.peer.send({ type: "task:log", task_id: active.taskId, line });
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
  const diff = await extractDiff(workDir);
  const patch = authHit ? "" : diff.patch;
  active.peer.send({ type: "task:diff", task_id: active.taskId, patch });
  if (authHit) {
    logger(`  ${YL}⚠${R}  auth failed — sending empty diff\n`);
  } else if (diff.patch) {
    logger(`  ${GR}✓${R}  ${diff.filesChanged} files changed (+${diff.insertions}/-${diff.deletions})\n`);
  } else {
    logger(`  ${YL}⚠${R}  No changes.\n`);
  }

  // Wait for the requester's spend:cosign, then validate and drive the settle.
  const spendPromise = new Promise<import("../../shared/events.ts").SpendEvent | null>((resolve) => {
    let done = false;
    const settle = (evt: import("../../shared/events.ts").SpendEvent | null) => {
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
  const spendOk = !authHit && spend !== null &&
    spend.task_id === active.taskId &&
    validAmount(spend.amount) &&
    spend.counterparty_pubkey === myPub &&
    verifyEd25519(
      canonicalStringify(eventWithoutSignature(spend)),
      spend.signature,
      rawHexToPublicKey(active.requesterPubkey),
    );

  if (!spendOk) {
    if (!authHit) {
      // spend === null means the requester cancelled (e.g. empty diff) or
      // the 120s window elapsed — a legitimate outcome, not a protocol
      // violation. Only a non-null-but-unverifiable spend is truly invalid.
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

  active.peer.send({ type: "task:settle", task_id: active.taskId, action: "approve" });
  logger(`  ${D}settle: approve${R}\n`);

  const earnPromise = new Promise<import("../../shared/events.ts").EarnEvent | null>((resolve) => {
    let done = false;
    const settle = (evt: import("../../shared/events.ts").EarnEvent | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(evt);
    };
    active.resolveEarn = settle;
    const t = setTimeout(() => settle(null), 30_000);
  });

  const earn = await earnPromise;
  const expectedEarn = splitFee(spend!.amount).acceptor;
  if (earn) {
    try {
      const earnOk =
        earn.task_id === active.taskId &&
        earn.amount === expectedEarn &&
        earn.counterparty_pubkey === active.requesterPubkey &&
        verifyEd25519(
          canonicalStringify(eventWithoutSignature(earn)),
          earn.signature,
          rawHexToPublicKey(earn.counterparty_pubkey),
        );
      if (!earnOk) {
        logger(`  ${YL}⚠${R}  earn:cosign invalid — skipping\n`);
      } else {
        await appendLocalEvent(myPub, earn);
        earned = earn.amount;
        logger(`  ${GR}✓${R}  earn cosigned · +${earn.amount}cr\n`);
      }
    } catch (err) {
      logger(`  ${YL}⚠${R}  failed to append earn: ${(err as Error).message}\n`);
    }
  } else {
    // earn-cosign DoS — requester sent settle=approve, signed and
    // forwarded a valid SpendEvent, then dropped before sending the
    // matching `earn:cosign`. We have no way to materialize a valid
    // EarnEvent here: replay validates `earn.signature` against the
    // counterparty (requester) pubkey, which we cannot impersonate.
    // Self-signing with our own key produces an event that fails
    // replay forever — silent credit loss. Better to surface the loss
    // and warn the user. v0.2 will add a `self_signed_via_spend_xref`
    // schema flag so the cross-ref alone can authorize the earn.
    logger(`  ${YL}⚠${R}  no earn cosign in 30s — credit not awarded (requester dropped after approve)\n`);
  }

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
  let replicationSwarm: ReturnType<typeof setInterval> | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { default: Hyperswarm } = (await import("hyperswarm")) as any;
    const repSwarm = new Hyperswarm();
    replicationSwarm = repSwarm;
    const store = await getCorestore();
    repSwarm.join(LEDGER_TOPIC);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repSwarm.on("connection", (conn: any) => store.replicate(conn));
    await Promise.race([repSwarm.flush(), new Promise<void>((r) => setTimeout(r, 5000))]);
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
        case "spend:cosign":
          if (msg.task_id !== active.taskId) return;
          active.resolveSpend?.(msg.spend_event);
          return;
        case "earn:cosign":
          if (msg.task_id !== active.taskId) return;
          active.resolveEarn?.(msg.earn_event);
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

    if (!msg.requester_ledger_key) {
      out(`  ${D}skip: ${msg.requester_pubkey.slice(0, 8)} missing ledger key${R}\n`);
      return;
    }
    // Persist the mapping before verifying balance — verifyEarnCrossRef at
    // replay time will look this up to open the requester's real core.
    await registerPeerLedgerKey(msg.requester_pubkey, msg.requester_ledger_key).catch(() => undefined);
    try {
      const requesterBalance = await getRemotePeerBalance(msg.requester_ledger_key, msg.requester_pubkey);
      if (requesterBalance <= 0) {
        out(`  ${D}skip: ${msg.requester_pubkey.slice(0, 8)} has no credits (${requesterBalance})${R}\n`);
        return;
      }
    } catch (err) {
      console.error(`[warn] Could not verify requester balance: ${err}. Rejecting task.`);
      return; // Fail closed: reject if we can't verify
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
    const claim: P2PMessage = {
      type: "task:claim",
      task_id: msg.task_id,
      acceptor_pubkey: myPub,
      rsa_public_key: rsaPubPem,
      next_nonce: myNextNonce,
    };
    peer.send(claim);

    active = {
      taskId: msg.task_id,
      requesterPubkey: msg.requester_pubkey,
      prompt: msg.prompt,
      model: msg.model,
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
