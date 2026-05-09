/**
 * ash interactive chat — P2P task submitter (ink TUI).
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import stringWidth from "string-width";
import { render, Box, Text, Static, useInput, useApp, useStdout, useCursor } from "ink";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { KeyObject } from "node:crypto";
import {
  loadConfig,
  loadIdentity,
  loadModels,
  loadModelTier,
  saveModelTier,
} from "../client.ts";
import { getOrCreateKeyPair } from "../../core/crypto/keypair.ts";
import {
  encryptAesKey,
  exportPublicKeyPem,
  importPublicKeyPem,
} from "../../core/crypto/rsa.ts";
import { packDirectory } from "../../core/packaging/pack.ts";
import { buildTaskAad } from "../../core/crypto/aes.ts";
import { applyPatch, getChangedFiles } from "../../core/diff/apply.ts";
import { signEd25519, verifyEd25519, rawHexToPublicKey } from "../../core/crypto/ed25519.ts";
import { canonicalStringify } from "../../shared/canonical.ts";
import {
  checkpointPayload,
  type SpendCheckpointEvent,
  type EarnCheckpointEvent,
} from "../../shared/events.ts";
import {
  appendCheckpointEvent,
  closeLocalStore,
  getLedgerCoreKey,
  getLocalBalance,
  getNextNonce,
  getRemotePeerBalance,
} from "../p2p_state.ts";
import { getCorestore } from "../../core/ledger/store.ts";
import { getEvents, getAdminMintsFor } from "../../core/ledger/events.ts";
import { registerPeerLedgerKey } from "../../core/ledger/peer_keys.ts";
import { LEDGER_TOPIC, ADMIN_LEDGER_KEY } from "../../shared/constants.ts";
import { resolveTier, splitFee } from "../../shared/policy.ts";
import { AshSwarm, type SwarmPeer } from "../../core/p2p/swarm.ts";
import type { P2PMessage } from "../../core/p2p/messages.ts";
import { sanitizeLogLine } from "../../core/p2p/messages.ts";
import type { Model } from "../../shared/types.ts";
import { DEFAULT_MODEL_TIER, modelToAgent } from "../../shared/types.ts";
import { CLIENT_VERSION, CHUNK_BYTES, MAX_PROMPT_SIZE } from "../../shared/protocol.ts";
import { validateAgentCredentials, ensureAgentLoggedIn, getAgentStatus } from "./init.ts";
import { fetchCurrentUser } from "../../core/github/client.ts";
import { AuthError, processTask, type ActiveTask } from "./serve.ts";
import { loadMineContext, runMineCore, runIssueQueryCore } from "./mine.ts";
import { LoginScreen, type LoginResult } from "./login_screen.tsx";

const A = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m" };

function applyInline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, `${A.bold}$1${A.reset}`)
    .replace(/`([^`]+)`/g, `${A.cyan}$1${A.reset}`);
}

function renderMarkdown(text: string): string[] {
  const out: string[] = [];
  let inCode = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("```")) { inCode = !inCode; out.push(""); continue; }
    if (inCode) { out.push(`  ${A.dim}${line}${A.reset}`); continue; }
    if (line.startsWith("### ")) out.push(`${A.bold}${A.cyan}${line.slice(4)}${A.reset}`);
    else if (line.startsWith("## "))  out.push(`${A.bold}${A.yellow}${line.slice(3)}${A.reset}`);
    else if (line.startsWith("# "))   out.push(`${A.bold}${A.green}${line.slice(2)}${A.reset}`);
    else if (/^\|[-| ]+\|$/.test(line)) continue; // table separator
    else if (line.startsWith("|") && line.endsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      out.push("  " + cells.join("  ·  "));
    }
    else if (/^[ \t]*[-*] /.test(line)) out.push(line.replace(/^([ \t]*)[-*] /, "$1• ").replace(/•(.*)/, (_, r) => `• ${applyInline(r.trim())}`));
    else out.push(applyInline(line));
  }
  const deduped: string[] = [];
  for (const l of out) {
    if (l === "" && deduped.length > 0 && deduped[deduped.length - 1] === "") continue;
    deduped.push(l);
  }
  while (deduped.length > 0 && deduped[deduped.length - 1] === "") deduped.pop();
  return deduped;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COMMANDS = [
  { cmd: "serve",   desc: "accept tasks to earn  (e.g. /serve 5)" },
  { cmd: "mine",    desc: "earn credits via GitHub  (e.g. /mine or /mine 3 or /mine \"bug query\")" },
  { cmd: "model",   desc: "pick a model  (e.g. /model sonnet)" },
  { cmd: "new",     desc: "start a new conversation (clear turn history)" },
  { cmd: "status",  desc: "show account info" },
  { cmd: "peers",   desc: "list connected peers" },
  { cmd: "history", desc: "show event history  (e.g. /history <pubkey>)" },
  { cmd: "login",   desc: "log in to GitHub / Claude / Codex" },
  { cmd: "clear",   desc: "clear chat scrollback" },
  { cmd: "help",    desc: "show available commands" },
  { cmd: "quit",    desc: "exit" },
];

interface MsgLine {
  id: number;
  text: string;
  color: string;
}

interface PendingTask {
  taskId: string;
  ciphertextB64: string;
  ivB64: string;
  aesKeyRaw: Uint8Array;
  prompt: string;
  cost: number;
  acceptorPeer: SwarmPeer | null;
  acceptorPubkey: string | null;
  acceptorLedgerKey: string | null;
  announce?: Extract<P2PMessage, { type: "task:announce" }>;
  onMatchPending?: (peer: SwarmPeer, claimNonce: number, rsaPubPem: string) => Promise<void>;
  onLog?: (line: string, historyOnly?: boolean) => void;
  onDiff?: (patch: string) => Promise<void>;
  resolveSettle?: (msg: { action: "approve" | "reject"; requester_checkpoint_cosig?: string; acceptor_earn_checkpoint?: EarnCheckpointEvent }) => void;
  // Cancel the in-flight request (broadcasts task:cancel and ends the
  // runRequest promise). Only set while `runRequest` is waiting.
  cancel?: (reason?: "user" | "timeout") => void;
  // Called when the acceptor sends task:cancel (e.g. blob transfer timeout).
  peerCancel?: () => void;

}

interface Turn {
  prompt: string;       // raw user prompt
  agentOutput: string;  // collected task:log lines
  diff?: string;        // git diff of changes (truncated if large)
  diffApplied: boolean; // whether the patch was actually applied
  cost: number;         // credits charged for this turn
}

interface ServeModeState {
  modelTier: string;
  agent: ReturnType<typeof modelToAgent>;
  rsaPubPem: string;
  maxTasks: number;        // Infinity for unlimited
  completed: number;
  stopRequested: boolean;
  active: ActiveTask | null;
  activeStartTs: number | null;
  activeLastLine: string;
}

interface ServeDisplay {
  modelTier: string;
  completed: number;
  maxTasks: number;
  stopping: boolean;
  busy: boolean;
  lastLine: string;
}

const WAITING_TIMEOUT_MS = 60_000;

interface ChatProps {
  userId: string;
  username: string;
  edPriv: KeyObject;
  models: Model[];
  initialModel: string;
  initialBalance: number;
  initialServed: number;
  setupPromise: Promise<{ balance: number; served: number }>;
  swarm: AshSwarm;
  absDir: string;
}

let _idCounter = 0;
const nextId = () => ++_idCounter;


function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

function ChatApp({
  userId, username, edPriv, models, initialModel, initialBalance, initialServed, setupPromise, swarm, absDir,
}: ChatProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termHeight = stdout?.rows ?? 24;

  const [msgs, setMsgs] = useState<MsgLine[]>(() => [
    { id: nextId(), text: "  type /help for commands · /quit to exit", color: "#555555" },
  ]);
  const [inputVal, setInputVal] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  const [menuItems, setMenuItems] = useState<{ cmd: string; desc: string }[]>([]);
  const [menuIdx, setMenuIdx] = useState(0);
  const [pickerActive, setPickerActive] = useState(false);
  const [pickerIdx, setPickerIdx] = useState(0);
  const [loginActive, setLoginActive] = useState(false);

  const [currentModel, setCurrentModelState] = useState(initialModel);
  const [balance, setBalance] = useState(initialBalance);
  const [served, setServed] = useState(initialServed);
  const [syncing, setSyncing] = useState(true);
  const [peerCount, setPeerCount] = useState(0);
  const [inflightStatus, setInflightStatus] = useState<{
    startTs: number;
    acceptorPubkey: string;
  } | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef = useRef<Turn[]>([]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);

  const [spinFrame, setSpinFrame] = useState(0);

  const ctxPct = React.useMemo(() => {
    if (turns.length === 0) return 0;
    const size = turns.reduce((acc, t, i) => acc
      + `### Turn ${i + 1}\nUser: ${t.prompt}\n\nAgent output:\n${t.agentOutput || "(no output)"}\n\nResult: ...\n\n`.length
      + (t.diff ? t.diff.length + 30 : 0), 0)
      + "## Previous conversation in this session\n\n## Current turn\n".length;
    return Math.min(99, Math.ceil(size / MAX_PROMPT_SIZE * 100));
  }, [turns]);

  const pendingRef = useRef<PendingTask | null>(null);
  const confirmResolveRef = useRef<((apply: boolean) => void) | null>(null);
  const currentModelRef = useRef(initialModel);
  const serveModeRef = useRef<ServeModeState | null>(null);
  const mineActiveRef = useRef(false);
  const [serveDisplay, setServeDisplay] = useState<ServeDisplay | null>(null);

  useEffect(() => { currentModelRef.current = currentModel; }, [currentModel]);

  useEffect(() => {
    setupPromise.then(({ balance: b, served: s }) => {
      setBalance(b);
      setServed(s);
      setSyncing(false);
    }).catch(() => setSyncing(false));
  }, []);

  const refreshServeDisplay = useCallback(() => {
    const sm = serveModeRef.current;
    if (!sm) { setServeDisplay(null); return; }
    setServeDisplay({
      modelTier: sm.modelTier,
      completed: sm.completed,
      maxTasks: sm.maxTasks,
      stopping: sm.stopRequested,
      busy: sm.active !== null,
      lastLine: sm.activeLastLine,
    });
  }, []);

  const addMsg = useCallback((text: string, color = "#cccccc") => {
    setMsgs((prev) => [...prev, { id: nextId(), text, color }]);
  }, []);

  const addMsgs = useCallback((lines: string[], color = "#cccccc") => {
    const newLines = lines.map((text) => ({ id: nextId(), text, color }));
    setMsgs((prev) => [...prev, ...newLines]);
  }, []);

  const updateLastMsg = useCallback((text: string, color?: string) => {
    setMsgs((prev) => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      const last = updated[updated.length - 1];
      updated[updated.length - 1] = color !== undefined
        ? { ...last, text, color }
        : { ...last, text };
      return updated;
    });
  }, []);

  // Spinner tick
  useEffect(() => {
    const t = setInterval(() => setSpinFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);

  // Setup swarm listeners
  useEffect(() => {
    const unsubConnect = swarm.onConnect(async (peer) => {
      setPeerCount(swarm.getPeers().length);
      const ledgerCoreKey = await getLedgerCoreKey(userId).catch(() => undefined);
      swarm.broadcast({
        type: "peer:info",
        pubkey: userId,
        username,
        model_tier: currentModelRef.current,
        ledger_core_key: ledgerCoreKey,
      });
      // Re-announce pending task to peers that connect after the initial broadcast.
      const p = pendingRef.current;
      if (p && !p.acceptorPeer && p.announce) {
        peer.send(p.announce);
      }
    });
    const unsubDisconnect = swarm.onDisconnect((peerId) => {
      setPeerCount(swarm.getPeers().length);
      const p = pendingRef.current;
      if (!p || p.acceptorPeer?.id !== peerId) return;
      // Acceptor peer dropped while task was in flight — unblock confirm/settle
      // so the user doesn't get permanently locked out of running new tasks.
      addMsg("  ⎿ acceptor disconnected — task aborted", "#ff8888");
      if (confirmResolveRef.current) {
        confirmResolveRef.current(true);
        confirmResolveRef.current = null;
      }
    });

    const claimAndProcess = async (
      peer: SwarmPeer,
      announce: Extract<P2PMessage, { type: "task:announce" }>,
    ): Promise<void> => {
      const state = serveModeRef.current;
      if (!state) return;
      const idx = state.completed + 1;
      const cap = isFinite(state.maxTasks) ? String(state.maxTasks) : "∞";
      const who = announce.requester_pubkey.slice(0, 8);

      let nextNonce: number;
      try { nextNonce = await getNextNonce(userId); } catch { return; }

      // Cache the requester's ledger core key so replay can verify our earn.
      await registerPeerLedgerKey(announce.requester_pubkey, announce.requester_ledger_key)
        .catch(() => undefined);

      const myLedgerKey = await getLedgerCoreKey(userId).catch(() => undefined);
      peer.send({
        type: "task:claim",
        task_id: announce.task_id,
        acceptor_pubkey: userId,
        rsa_public_key: state.rsaPubPem,
        next_nonce: nextNonce,
        acceptor_ledger_key: myLedgerKey,
      });

      state.active = {
        taskId: announce.task_id,
        requesterPubkey: announce.requester_pubkey,
        prompt: announce.prompt,
        model: announce.model,
        peer,
      };
      state.activeStartTs = Date.now();
      state.activeLastLine = "";
      refreshServeDisplay();

      const serveLogger = (raw: string): void => {
        const cleaned = raw.replace(/\x1b\[[0-9;]*m/g, "");
        for (const line of cleaned.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) {
            state.activeLastLine = trimmed;
            refreshServeDisplay();
          }
        }
      };

      try {
        await ensureAgentLoggedIn(state.agent);
        const { earned } = await processTask(state.active, userId, state.modelTier, serveLogger);
        state.completed += 1;
        const bal = (await getLocalBalance(userId)).balance;
        setBalance(bal);
        setServed((n) => n + 1);
        addMsg(
          `  ⎿ [${idx}/${cap}] task from ${who}…  → +${earned}cr  (balance: ${bal}cr)`,
          earned > 0 ? "#7cd38a" : "#6b6b6b",
        );
      } catch (err) {
        if (err instanceof AuthError) {
          addMsg(`  ⎿ [${idx}/${cap}] session expired — stopping serve mode`, "#ff8888");
          state.stopRequested = true;
        } else {
          addMsg(`  ⎿ [${idx}/${cap}] error: ${(err as Error).message}`, "#e3bd5a");
        }
      } finally {
        state.active = null;
        state.activeStartTs = null;
        state.activeLastLine = "";
        refreshServeDisplay();
      }

      if (!serveModeRef.current) return;
      if (state.stopRequested || state.completed >= state.maxTasks) {
        const reason = state.completed >= state.maxTasks ? "done" : "stopped";
        const line = reason === "done"
          ? `─── serve mode ended · ${state.completed} tasks processed ───`
          : `─── serve mode stopped · ${state.completed} tasks processed ───`;
        addMsg(line, "#00c8ff");
        serveModeRef.current = null;
        refreshServeDisplay();
      }
    };

    const unsubMessage = swarm.onMessage(async (peer, msg) => {
      // Cache any ledger core key the peer advertises so future cross-ref
      // at balance replay can open their real Hypercore.
      if (msg.type === "peer:info") {
        // Only trust the ledger key when peer:info matches the
        // handshake-verified identity (cache-poisoning defense — see
        // serve.ts for the same pattern).
        if (msg.pubkey === peer.pubkey) {
          registerPeerLedgerKey(msg.pubkey, msg.ledger_core_key).catch(() => undefined);
        }
        return;
      }

      // ── Serve mode (acceptor) ──────────────────────────────────────────
      const sm = serveModeRef.current;
      if (sm) {
        if (sm.active && sm.active.peer.id === peer.id) {
          switch (msg.type) {
            case "task:match":
              if (msg.task_id !== sm.active.taskId) return;
              sm.active.encryptedAesKeyB64 = msg.encrypted_aes_key;
              sm.active.blobIvB64 = msg.blob_iv;
              sm.active.resolveMatch?.();
              return;
            case "task:blob":
              if (msg.task_id !== sm.active.taskId) return;
              sm.active.blobB64 = msg.data;
              sm.active.resolveBlob?.();
              return;
            case "task:blob_chunk": {
              if (msg.task_id !== sm.active.taskId) return;
              if (!sm.active.blobChunks) sm.active.blobChunks = new Array(msg.total);
              sm.active.blobChunks[msg.index] = msg.data;
              const received = sm.active.blobChunks.filter((s) => s !== undefined).length;
              sm.active.onBlobChunk?.(received, msg.total);
              if (received >= msg.total) {
                sm.active.blobB64 = sm.active.blobChunks.join("");
                sm.active.resolveBlob?.();
              }
              return;
            }
            case "spend:cosign":
              if (msg.task_id !== sm.active.taskId) return;
              sm.active.resolveSpend?.(msg.spend_checkpoint);
              return;
            case "earn:cosign":
              if (msg.task_id !== sm.active.taskId) return;
              sm.active.resolveEarn?.({ acceptor_checkpoint_cosig: msg.acceptor_checkpoint_cosig, acceptor_earn_checkpoint: msg.acceptor_earn_checkpoint });
              return;
            case "task:cancel":
              if (msg.task_id !== sm.active.taskId) return;
              sm.active.resolveSpend?.(null);
              return;
          }
          return;
        }
        if (msg.type === "task:announce") {
          if (sm.active || sm.stopRequested) return;
          if (msg.requester_pubkey === userId) return;            // no self-serve
          if (msg.requester_pubkey !== peer.pubkey) return;       // reject spoofed requester
          if (msg.model !== sm.modelTier) return;
          if (sm.completed >= sm.maxTasks) return;
          await claimAndProcess(peer, msg);
        }
        return;
      }

      // ── Chat mode (requester) ──────────────────────────────────────────
      const p = pendingRef.current;
      if (!p) return;
      switch (msg.type) {
        case "task:price_mismatch": {
          if (msg.task_id !== p.taskId) return;
          const myVer = CLIENT_VERSION;
          const theirVer = msg.acceptor_app_version;
          const whoUpdates = semverGt(theirVer, myVer)
            ? `update ash to v${theirVer} (run: npm i -g @doheon/ash)`
            : `acceptor is on an older version (${theirVer}) — ask them to update`;
          addMsg(
            `  ⎿ price mismatch · acceptor requires ${msg.expected_cost}cr, you offered ${p.cost}cr · ${whoUpdates}`,
            "#e3bd5a",
          );
          finish();
          return;
        }
        case "task:claim":
          if (msg.task_id !== p.taskId) return;
          if (p.acceptorPeer) return;
          if (msg.acceptor_pubkey !== peer.pubkey) return; // reject spoofed acceptor identity
          p.acceptorPeer = peer;
          p.acceptorPubkey = msg.acceptor_pubkey;
          p.acceptorLedgerKey = msg.acceptor_ledger_key ?? null;
          await p.onMatchPending?.(peer, msg.next_nonce, msg.rsa_public_key);
          break;
        case "task:blob_request": {
          if (msg.task_id !== p.taskId || peer.id !== p.acceptorPeer?.id) return;
          const totalBytes = p.ciphertextB64.length * 3 / 4;
          const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
          const chunkB64 = Math.ceil(CHUNK_BYTES * 4 / 3);
          const totalChunks = Math.ceil(p.ciphertextB64.length / chunkB64);
          const BAR_WIDTH = 22;
          const uploadStart = Date.now();
          for (let i = 0; i < totalChunks; i++) {
            peer.send({
              type: "task:blob_chunk",
              task_id: p.taskId,
              index: i,
              total: totalChunks,
              data: p.ciphertextB64.slice(i * chunkB64, (i + 1) * chunkB64),
            });
            const sentBytes = Math.min((i + 1) * CHUNK_BYTES, totalBytes);
            const ratio = (i + 1) / totalChunks;
            const filled = Math.floor(BAR_WIDTH * ratio);
            const isLast = i === totalChunks - 1;
            const bar = isLast
              ? "█".repeat(BAR_WIDTH)
              : "█".repeat(Math.max(0, filled - 1)) + "▒" + "░".repeat(BAR_WIDTH - filled);
            const pct = Math.round(ratio * 100).toString().padStart(3);
            const sentMB = (sentBytes / 1024 / 1024).toFixed(1).padStart(5);
            const elapsed = (Date.now() - uploadStart) / 1000;
            const speedStr = elapsed > 0.2
              ? `  ·  ${(sentBytes / elapsed / 1024 / 1024).toFixed(1)} MB/s`
              : "";
            updateLastMsg(`  ↑  ${bar}  ${pct}%  ·  ${sentMB}/${totalMB} MB${speedStr}`, "#00c8ff");
            if (i % 10 === 9 || isLast) {
              await new Promise<void>((r) => setTimeout(r, 0));
            }
          }
          const elapsed = (Date.now() - uploadStart) / 1000;
          const avgSpeed = elapsed > 0 ? (totalBytes / elapsed / 1024 / 1024).toFixed(1) : "—";
          updateLastMsg(`  ↑  ${totalMB} MB uploaded  ·  ${avgSpeed} MB/s avg  ·  running…`, "#7cd38a");
          break;
        }
        case "task:cancel":
          if (msg.task_id !== p.taskId || peer.id !== p.acceptorPeer?.id) return;
          p.peerCancel?.();
          break;
        case "task:log":
          if (msg.task_id !== p.taskId || peer.id !== p.acceptorPeer?.id) return;
          p.onLog?.(sanitizeLogLine(msg.line), msg.history_only);
          break;
        case "task:diff":
          if (msg.task_id !== p.taskId || peer.id !== p.acceptorPeer?.id) return;
          await p.onDiff?.(msg.patch);
          break;
        case "task:settle":
          if (msg.task_id !== p.taskId || peer.id !== p.acceptorPeer?.id) return;
          if (p.resolveSettle) {
            p.resolveSettle({ action: msg.action, requester_checkpoint_cosig: msg.requester_checkpoint_cosig, acceptor_earn_checkpoint: msg.acceptor_earn_checkpoint });
          } else if (msg.action === "reject" && confirmResolveRef.current) {
                  addMsg("  ⎿ acceptor timed out — no credits charged", "#e3bd5a");
            confirmResolveRef.current(true);
            confirmResolveRef.current = null;
          }
          break;
      }
    });
    return () => {
      unsubConnect();
      unsubDisconnect();
      unsubMessage();
    };
  }, []);

  const doExit = useCallback(() => {
    const sm = serveModeRef.current;
    if (sm?.active) {
      sm.active.peer.send({ type: "task:cancel", task_id: sm.active.taskId });
    }
    const p = pendingRef.current;
    if (p) {
      if (p.acceptorPeer) p.acceptorPeer.send({ type: "task:cancel", task_id: p.taskId });
      else swarm.broadcast({ type: "task:cancel", task_id: p.taskId });
    }
    closeLocalStore().catch(() => undefined);
    swarm.destroy().catch(() => undefined);
    exit();
  }, [exit, swarm]);

  useEffect(() => {
    process.on("SIGTERM", doExit);
    return () => {
      process.off("SIGTERM", doExit);
    };
  }, [doExit]);

  const creditsFor = (t: string) => models.find((m) => m.tier === t)?.credits ?? 15;
  const labelFor   = (t: string) => models.find((m) => m.tier === t)?.display_name ?? t;

  const buildPromptWithHistory = (userPrompt: string): string => {
    const LIMIT = MAX_PROMPT_SIZE;
    const build = (slice: Turn[]): string => {
      if (slice.length === 0) return userPrompt;
      const parts: string[] = ["## Previous conversation in this session", ""];
      slice.forEach((t, i) => {
        parts.push(`### Turn ${i + 1}`);
        parts.push(`User: ${t.prompt}`);
        parts.push("");
        parts.push("Agent output:");
        parts.push(t.agentOutput || "(no output)");
        if (t.diff) {
          parts.push("");
          parts.push(`Changes (${t.diffApplied ? "applied" : "not applied"}):`);
          parts.push("```diff");
          parts.push(t.diff);
          parts.push("```");
        }
        parts.push("");
        parts.push(`Result: ${t.diffApplied ? "changes applied" : "no changes applied"}`);
        parts.push("");
      });
      parts.push("## Current turn");
      parts.push(userPrompt);
      return parts.join("\n");
    };
    // Drop oldest turns until the full prompt fits within the wire limit.
    let slice = [...turnsRef.current];
    while (slice.length > 0 && build(slice).length > LIMIT) slice.shift();
    return build(slice);
  };

  const runRequest = useCallback(async (prompt: string) => {
    if (pendingRef.current) {
      addMsg("  ⎿ a task is already in flight; wait for it to finish.", "#e3bd5a");
      return;
    }
    // Wrap the entire flow in try/finally so any uncaught throw between
    // setting `pendingRef.current` and the inner Promise's `finish()`
    // still clears the lock. Without this guard, a thrown error from
    // (e.g.) `getLedgerCoreKey` or `swarm.broadcast` left `pendingRef`
    // populated forever, blocking every subsequent task in this
    // session with "a task is already in flight."
    try {
    addMsg(`❯ ${prompt}`, "#eaeaea");
    const cost = creditsFor(currentModelRef.current);
    const fullPrompt = buildPromptWithHistory(prompt);

    const { balance: currentBalance } = await getLocalBalance(userId);
    if (currentBalance < cost) {
      addMsg(
        `  ⎿ not enough credits · need ${cost}cr for ${currentModelRef.current} · have ${currentBalance}cr · run /mine to earn more`,
        "#e3bd5a",
      );
      return;
    }

    if (swarm.getPeers().length === 0) {
      addMsg("  ⎿ no peers connected; nobody can accept your task.", "#e3bd5a");
      return;
    }

    addMsg(`  ${FRAMES[0]} packaging…`, "#6b6b6b");

    const taskId = randomUUID();
    const aad = buildTaskAad(taskId, userId);
    let aesKeyRaw: Uint8Array;
    let ciphertextB64: string;
    let ivB64: string;
    let blobSize = 0;

    try {
      const { ciphertext, iv, aesKeyRaw: keyRaw } = await packDirectory(absDir, aad);
      aesKeyRaw = keyRaw;
      ciphertextB64 = Buffer.from(ciphertext).toString("base64");
      ivB64 = Buffer.from(iv).toString("base64");
      blobSize = ciphertext.length;
    } catch (err) {
      updateLastMsg(`  ✗ ${(err as Error).message.split("\n")[0]}`);
      return;
    }
    updateLastMsg(`  ✓ packaged  (${(blobSize / 1024).toFixed(1)} KB)`);

    const myRsa = await getOrCreateKeyPair(userId);
    const myRsaPubPem = await exportPublicKeyPem(myRsa.publicKey);

    pendingRef.current = {
      taskId, ciphertextB64, ivB64, aesKeyRaw: aesKeyRaw!,
      prompt, cost,
      acceptorPeer: null, acceptorPubkey: null, acceptorLedgerKey: null,
    };

    const requesterLedgerKey = await getLedgerCoreKey(userId).catch(() => undefined);
    const announce: P2PMessage = {
      type: "task:announce",
      task_id: taskId,
      prompt: fullPrompt,
      model: currentModelRef.current,
      blob_size: blobSize,
      requester_pubkey: userId,
      rsa_public_key: myRsaPubPem,
      timestamp: new Date().toISOString(),
      requester_ledger_key: requesterLedgerKey,
      credit_cost: cost,
    };
    swarm.broadcast(announce);
    if (pendingRef.current) {
      pendingRef.current.announce = announce as Extract<P2PMessage, { type: "task:announce" }>;
    }
    addMsg(`  ⎿ announced  (${taskId.slice(0, 8)})`, "#6b6b6b");
    addMsg(`  ${FRAMES[0]} waiting for acceptor…  (esc to cancel)`, "#6b6b6b");

    let agentBuffer = "";   // all lines → stored in Turn for follow-up context
    let displayBuffer = ""; // assistant text only (historyOnly:false) → shown to user

    await new Promise<void>((resolve) => {
      let done = false;
      let waitingTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (waitingTimer) { clearTimeout(waitingTimer); waitingTimer = null; }
        setInflightStatus(null);
        pendingRef.current = null;
        resolve();
      };

      pendingRef.current!.cancel = (reason: "user" | "timeout" = "user") => {
        const p = pendingRef.current;
        if (!p || done) return;
        if (p.acceptorPeer) p.acceptorPeer.send({ type: "task:cancel", task_id: taskId });
        else swarm.broadcast({ type: "task:cancel", task_id: taskId });
        addMsg(
          reason === "timeout"
            ? `  ⎿ no acceptor within ${Math.round(WAITING_TIMEOUT_MS / 1000)}s · cancelled`
            : "  ⎿ cancelled",
          "#e3bd5a",
        );
        finish();
      };

      pendingRef.current!.peerCancel = () => {
        if (done) return;
        addMsg("  ⎿ upload timed out on acceptor — no credits charged", "#ff8888");
        finish();
      };

      // Safety net: auto-cancel if no one claims the task in time. The
      // timer's callback bails if a match has already landed.
      waitingTimer = setTimeout(() => {
        const p = pendingRef.current;
        if (!p || p.acceptorPeer) return;
        p.cancel?.("timeout");
      }, WAITING_TIMEOUT_MS);

      pendingRef.current!.onMatchPending = async (peer, _claimNonce, rsaPubPem) => {
        try {
          const acceptorPub = await importPublicKeyPem(rsaPubPem);
          const encAes = await encryptAesKey(aesKeyRaw!, acceptorPub);
          peer.send({ type: "task:match", task_id: taskId, encrypted_aes_key: encAes, blob_iv: ivB64 });
          updateLastMsg("  ● matched · running");
          setInflightStatus({
            startTs: Date.now(),
            acceptorPubkey: pendingRef.current?.acceptorPubkey ?? peer.pubkey,
          });
        } catch (err) {
          addMsg(`  ⎿ match failed: ${(err as Error).message}`, "#ff8888");
          finish();
        }
      };

      pendingRef.current!.onLog = (line, historyOnly) => {
        agentBuffer += line + "\n";
        if (!historyOnly) displayBuffer += line + "\n";
        if (!historyOnly && line.trim()) {
          const truncated = line.length > 80 ? line.slice(0, 80) + "…" : line;
          updateLastMsg(`  ● ${truncated}`, "#aaaaaa");
        }
      };

      pendingRef.current!.onDiff = async (patch) => {
        const p = pendingRef.current!;
        const fullCost = cost;
        const halfCost = Math.floor(cost / 2);
        const hasPatch = !!patch && patch.trim() !== "";

        // Render accumulated agent output as markdown before showing diff info.
        if (displayBuffer.trim()) {
          const lines = renderMarkdown(displayBuffer.trim());
          if (lines.length > 0) {
            updateLastMsg(lines[0]);
            if (lines.length > 1) {
              addMsgs(lines.slice(1));
            }
          }
        }

        // Decide outcome: full charge on apply; half on reject / empty-diff /
        // no-response. Acceptor still did the work, so a partial charge keeps
        // the economics honest.
        let amount: number;
        let applyRequested = false;
        let outcomeLabel: string;

        if (!hasPatch) {
          amount = halfCost;
          outcomeLabel = "no changes";
          addMsg(`  ⎿ no diff · auto half-charge (${halfCost}cr)`, "#e3bd5a");
        } else {
          const files = getChangedFiles(patch);
          const insertions = (patch.match(/^\+[^+]/gm) ?? []).length;
          const deletions  = (patch.match(/^-[^-]/gm) ?? []).length;
          addMsg(`  ⎿ ${files.length} file${files.length === 1 ? "" : "s"} changed  +${insertions} / -${deletions}`, "#7cd38a");
          // Sanitize each filename before display: a hostile acceptor
          // could craft a patch with ANSI escapes in the file path
          // (terminal-title spoof, OSC 52 clipboard write, etc.).
          // The wire-side `sanitizeLogLine` strips C0 / CSI / OSC.
          for (const f of files) addMsg(`  ⎿ • ${sanitizeLogLine(f)}`, "#6b6b6b");
          amount = fullCost;
          applyRequested = true;
          outcomeLabel = "applied";
        }

        // Build SpendCheckpointEvent inside the per-pubkey mutex so balance + nonce
        // are read atomically with the append. Earn checkpoint is validated here too
        // (before spend append) so a bad earn cannot arrive after we're committed.
        let spendSettled = false;
        let settleEarnCheckpoint: EarnCheckpointEvent | undefined;
        await appendCheckpointEvent(userId, async (spendNonce, currentBalance) => {
          const spendCheckpointBase: Omit<SpendCheckpointEvent, "signature"> = {
            type: "spend_checkpoint",
            nonce: spendNonce,
            timestamp: new Date().toISOString(),
            balance: currentBalance - amount,
            amount,
            task_id: taskId,
            counterparty_pubkey: p.acceptorPubkey ?? "",
            owner_pubkey: userId,
            sig_counterparty: "",
          };
          const spendCheckpoint: SpendCheckpointEvent = {
            ...spendCheckpointBase,
            signature: signEd25519(canonicalStringify(checkpointPayload(spendCheckpointBase as SpendCheckpointEvent)), edPriv),
          };
          p.acceptorPeer?.send({ type: "spend:cosign", task_id: taskId, spend_checkpoint: spendCheckpoint });

          const settleMsg = await new Promise<{ action: "approve" | "reject"; requester_checkpoint_cosig?: string; acceptor_earn_checkpoint?: EarnCheckpointEvent }>((resolve) => {
            let done = false;
            const settle = (v: { action: "approve" | "reject"; requester_checkpoint_cosig?: string; acceptor_earn_checkpoint?: EarnCheckpointEvent }) => {
              if (done) return;
              done = true;
              clearTimeout(t);
              resolve(v);
            };
            p.resolveSettle = settle;
            const t = setTimeout(() => settle({ action: "reject" }), 30_000);
          });
          p.resolveSettle = undefined;

          if (settleMsg.action !== "approve") throw new Error("rejected");

          const cosig = settleMsg.requester_checkpoint_cosig;
          if (!cosig) throw new Error("missing-cosig");

          // Verify acceptor's Ed25519 cosignature over our spend checkpoint payload.
          const cosigOk = p.acceptorPubkey
            ? verifyEd25519(
                canonicalStringify(checkpointPayload(spendCheckpoint)),
                cosig,
                rawHexToPublicKey(p.acceptorPubkey),
              )
            : false;
          if (!cosigOk) throw new Error("cosig-invalid");

          // Validate earn checkpoint BEFORE spend append (settlement ordering).
          // Hard-reject if ledger key missing or replication fails — mirrors the
          // acceptor-side balanceLookupOk pattern (C-2/C-3 fix).
          const aec = settleMsg.acceptor_earn_checkpoint;
          if (!aec) throw new Error("earn-missing");
          if (!p.acceptorLedgerKey) throw new Error("earn-no-ledger-key");
          const expectedAcceptorEarn = splitFee(amount).acceptor;
          let earnLookupOk = false;
          let prevAcceptorBalance = 0;
          let acceptorCoreLength = -1;
          try {
            const aecInfo = await getRemotePeerBalance(p.acceptorLedgerKey, p.acceptorPubkey!);
            prevAcceptorBalance = aecInfo.balance;
            acceptorCoreLength = aecInfo.coreLength;
            earnLookupOk = true;
          } catch { /* replication failed — hard reject */ }
          let aecSigOk = false;
          try {
            aecSigOk = verifyEd25519(
              canonicalStringify(checkpointPayload(aec)),
              aec.signature,
              rawHexToPublicKey(p.acceptorPubkey!),
            );
          } catch { /* malformed */ }
          const aecValid =
            earnLookupOk &&
            aec.nonce === acceptorCoreLength &&
            aec.balance === prevAcceptorBalance + expectedAcceptorEarn &&
            aec.type === "earn_checkpoint" &&
            aec.task_id === taskId &&
            aec.amount === expectedAcceptorEarn &&
            aec.counterparty_pubkey === userId &&
            aec.owner_pubkey === p.acceptorPubkey &&
            aecSigOk;
          if (!aecValid) throw new Error("earn-invalid");
          settleEarnCheckpoint = aec;

          // spendSettled is set only after appendEvent succeeds (torn-append fix).
          return { ...spendCheckpoint, sig_counterparty: cosig };
        }).then(() => {
          spendSettled = true;
        }).catch((err: unknown) => {
          const msg = (err as Error).message;
          if (msg === "rejected") {
            addMsg("  ⎿ acceptor rejected · no credits charged", "#e3bd5a");
          } else if (msg === "missing-cosig") {
            addMsg("  ⎿ acceptor missing spend cosig — no credits charged", "#e3bd5a");
          } else if (msg === "cosig-invalid") {
            addMsg("  ⎿ acceptor spend cosig invalid — no credits charged", "#e3bd5a");
          } else if (msg === "earn-missing" || msg === "earn-no-ledger-key" || msg === "earn-invalid") {
            addMsg("  ⎿ acceptor earn checkpoint invalid — no earn cosign sent", "#e3bd5a");
          } else {
            addMsg(`  ⎿ local spend log failed: ${msg}`, "#ff8888");
          }
        });

        if (!spendSettled) {
          finish();
          return;
        }

        setBalance((b) => b - amount);

        // Earn checkpoint was validated inside the spend mutex — just cosign and send.
        // Send BEFORE applyPatch so the acceptor's 30s earn:cosign window is not
        // consumed by local filesystem I/O (large patches can take several seconds).
        if (p.acceptorPubkey && settleEarnCheckpoint) {
          const earnCosig = signEd25519(canonicalStringify(checkpointPayload(settleEarnCheckpoint)), edPriv);
          p.acceptorPeer?.send({
            type: "earn:cosign",
            task_id: taskId,
            acceptor_checkpoint_cosig: earnCosig,
            acceptor_earn_checkpoint: settleEarnCheckpoint,
          });
        }

        // Apply patch if user said yes.
        let appliedOk = true;
        if (applyRequested && hasPatch) {
          const applied = await applyPatch(patch!, absDir);
          appliedOk = applied.success;
        }

        const label = applyRequested
          ? (appliedOk ? "patch applied" : "patch conflict")
          : outcomeLabel;
        const color = applyRequested && appliedOk ? "#7cd38a" : "#e3bd5a";
        addMsg(`  ⎿ ${label} · ${amount}cr spent`, color);

        // Save this turn to conversation history so the next task can
        // reference it via buildPromptWithHistory.
        const MAX_DIFF = 2000;
        const newTurn: Turn = {
          prompt,
          agentOutput: agentBuffer.trim(),
          diff: hasPatch
            ? (patch!.length > MAX_DIFF ? patch!.slice(0, MAX_DIFF) + "\n... (truncated)" : patch!)
            : undefined,
          diffApplied: applyRequested && appliedOk,
          cost: amount,
        };
        setTurns((prev) => [...prev, newTurn]);

        finish();
      };
    });
    } finally {
      // Defensive cleanup: anything between `pendingRef.current = {...}`
      // and the inner Promise's `finish()` that throws would otherwise
      // leave the lock set forever. The Promise body itself sets
      // `pendingRef.current = null` inside `finish()`, so under the
      // happy path this is a no-op.
      pendingRef.current = null;
      setInflightStatus(null);
    }
  }, [addMsg, updateLastMsg, swarm, userId, edPriv, absDir, models]);

  const enterServeMode = useCallback(async (nArg: number | undefined) => {
    if (pendingRef.current) {
      addMsg("  ⎿ a request is in flight; wait for it before /serve.", "#e3bd5a");
      return;
    }
    if (serveModeRef.current) {
      addMsg("  ⎿ already serving.", "#e3bd5a");
      return;
    }
    const modelTier = currentModelRef.current;
    const agent = modelToAgent(modelTier);

    if (!(await validateAgentCredentials(agent))) {
      addMsg(`  ⎿ ${agent} credentials missing or expired — run /login to refresh.`, "#ff8888");
      return;
    }

    const rsa = await getOrCreateKeyPair(userId);
    const rsaPubPem = await exportPublicKeyPem(rsa.publicKey);

    serveModeRef.current = {
      modelTier, agent, rsaPubPem,
      maxTasks: nArg ?? Infinity,
      completed: 0,
      stopRequested: false,
      active: null,
      activeStartTs: null,
      activeLastLine: "",
    };

    const countStr = nArg !== undefined ? `${nArg} tasks` : "unlimited";
    addMsg(`─── serve mode · ${modelTier} · ${countStr} · esc to stop ───`, "#00c8ff");

    const ledgerCoreKey = await getLedgerCoreKey(userId).catch(() => undefined);
    swarm.broadcast({
      type: "peer:info",
      pubkey: userId,
      username,
      model_tier: modelTier,
      ledger_core_key: ledgerCoreKey,
    });

    refreshServeDisplay();
  }, [addMsg, swarm, userId, username, refreshServeDisplay]);

  const dispatch = useCallback(async (input: string) => {
    if (confirmResolveRef.current) {
      const answer = input.trim().toLowerCase();
      confirmResolveRef.current(answer === "y" || answer === "yes");
      return;
    }
    if (!input.startsWith("/") && serveModeRef.current) {
      addMsg("  ⎿ serve mode active · esc to stop", "#e3bd5a");
      return;
    }
    if (!input.startsWith("/")) { await runRequest(input); return; }
    const [cmd, ...args] = input.slice(1).trim().split(/\s+/);
    if (cmd.toLowerCase() !== "clear") addMsg(`❯ ${input}`, "#555555");
    switch (cmd.toLowerCase()) {
      case "q": case "quit": case "exit": doExit(); break;
      case "": case "help":
        addMsgs([
          "Commands:",
          "  /serve [N]        accept tasks (N = count; omit for unlimited)",
          "  /mine [N|\"query\"] earn credits via GitHub (N = task count; or pass a query string)",
          "  /model            interactive model picker",
          "  /model <tier>     switch directly",
          "  /new              start a new conversation (clear turn history)",
          "  /status           show account info",
          "  /peers            list connected peers",
          "  /history          show event history",
          "  /login            log in to GitHub / Claude / Codex",
          "  /clear            clear chat scrollback",
          "  /quit             exit",
        ], "#888888");
        break;
      case "new": {
        if (pendingRef.current) {
          addMsg("  ⎿ task in flight; wait for it to finish.", "#e3bd5a");
          break;
        }
        if (turnsRef.current.length === 0) {
          addMsg("  ⎿ no conversation to clear.", "#888888");
          break;
        }
        setTurns([]);
        addMsg("─── new conversation · turn history cleared ───", "#00c8ff");
        break;
      }
      case "serve": {
        const n = args[0] ? parseInt(args[0], 10) : undefined;
        if (args[0] && (!Number.isInteger(n) || (n as number) <= 0)) {
          addMsg("Usage: /serve [N]  (N = positive integer; omit for unlimited)", "#ff8888");
          break;
        }
        await enterServeMode(n);
        break;
      }
      case "mine": {
        if (pendingRef.current) { addMsg("  ⎿ task in flight; wait for it to finish.", "#e3bd5a"); break; }
        if (serveModeRef.current) { addMsg("  ⎿ stop serve mode first (esc).", "#e3bd5a"); break; }
        if (mineActiveRef.current) { addMsg("  ⎿ mine already running.", "#e3bd5a"); break; }

        const ctx = await loadMineContext();
        if ("error" in ctx) { addMsg(`  ⎿ ${ctx.error}`, "#ff8888"); break; }

        const firstArg = args[0];
        const isCount = firstArg !== undefined && /^\d+$/.test(firstArg);
        const count = isCount ? parseInt(firstArg, 10) : 1;
        const query = !isCount && firstArg ? args.join(" ") : undefined;

        const label = query ? `query: "${query}"` : `${count} task(s)`;
        addMsg(`─── mine · ${label} · @${ctx.ghLogin} ───`, "#00c8ff");

        const mineLogger = (raw: string): void => {
          const cleaned = raw.replace(/\x1b\[[0-9;]*m/g, "");
          for (const line of cleaned.split("\n")) {
            if (line.trim()) addMsg(`  ${line.trim()}`, "#6b6b6b");
          }
        };

        const mineConfirm = (prompt: string): Promise<boolean> => {
          if (confirmResolveRef.current) {
            // Another confirm is in flight (e.g. a parallel diff prompt). Refuse
            // safely instead of overwriting the resolver.
            addMsg(`  ⎿ ${prompt}  → blocked: another confirmation is active`, "#ff8888");
            return Promise.resolve(false);
          }
          addMsg(`  ⎿ ${prompt} (y/n)`, "#ffcc44");
          return new Promise<boolean>((resolve) => {
            confirmResolveRef.current = (apply) => {
              confirmResolveRef.current = null;
              resolve(apply);
            };
          });
        };

        mineActiveRef.current = true;
        (query
          ? runIssueQueryCore(ctx, query, mineLogger, mineConfirm)
          : runMineCore(ctx, { count }, mineLogger, mineConfirm)
        ).then(async () => {
          const { balance: b } = await getLocalBalance(userId);
          setBalance(b);
          addMsg(`─── mine complete · balance: ${b}cr ───`, "#00c8ff");
        }).catch((err: Error) => {
          addMsg(`  ⎿ mine error: ${err.message}`, "#ff8888");
        }).finally(() => {
          mineActiveRef.current = false;
        });
        break;
      }
      case "clear":
        setMsgs([{ id: nextId(), text: "  type /help for commands · /quit to exit", color: "#555555" }]);
        setTurns([]);
        turnsRef.current = [];
        break;
      case "status": {
        const [{ balance: b }, cfg, claudeStatus, codexStatus] = await Promise.all([
          getLocalBalance(userId),
          loadConfig(),
          getAgentStatus("claude"),
          getAgentStatus("codex"),
        ]);
        setBalance(b);
        let githubStr = "—";
        if (cfg.githubToken) {
          const u = await fetchCurrentUser(cfg.githubToken).catch(() => null);
          githubStr = u ? `@${u.login}` : "token invalid";
        }
        const authStr = (s: string) =>
          s === "valid" ? "✓ valid" : s === "expired" ? "⚠ expired" : "—";
        addMsgs([
          `user:    ${username}`,
          `pubkey:  ${cfg.pubkey ?? "—"}`,
          `model:   ${labelFor(currentModelRef.current)}  (${creditsFor(currentModelRef.current)}cr/task)`,
          `balance: ${b} credits`,
          `served:  ${served} tasks`,
          `peers:   ${swarm.getPeers().length}`,
          `cwd:     ${process.cwd().replace(homedir(), "~")}`,
          `github:  ${githubStr}`,
          `claude:  ${authStr(claudeStatus)}`,
          `codex:   ${authStr(codexStatus)}`,
        ], "#88ccff");
        break;
      }
      case "history": {
        const target = args[0] ?? userId;
        const [own, mints] = await Promise.all([getEvents(target), getAdminMintsFor(target)]);
        const all = [...own, ...mints].sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
        if (all.length === 0) {
          addMsg("no events", "#888888");
          break;
        }
        for (const evt of all) {
          const ts = evt.timestamp.slice(0, 19).replace("T", " ");
          if (evt.type === "earn") {
            addMsg(`  ${ts}  earn   +${String(evt.amount).padStart(4)} cr  from ${evt.counterparty_pubkey.slice(0, 8)}…`, "#7cd38a");
          } else if (evt.type === "spend") {
            addMsg(`  ${ts}  spend  -${String(evt.amount).padStart(4)} cr  to   ${evt.counterparty_pubkey.slice(0, 8)}…`, "#e3bd5a");
          } else if (evt.type === "mint") {
            addMsg(`  ${ts}  mint   +${String(evt.amount).padStart(4)} cr  admin  (${evt.reason})`, "#88ccff");
          }
        }
        // Same validated balance path as /status, `ash status`, and the
        // requester-credit check in serve — raw event sum can diverge.
        const bal = (await getLocalBalance(target)).balance;
        addMsg(`balance: ${bal} cr`, "#88ff88");
        break;
      }
      case "peers": {
        const ps = swarm.getPeers();
        if (ps.length === 0) addMsg("no peers connected", "#888888");
        else for (const id of ps) addMsg(`  ${id.slice(0, 16)}…`, "#888888");
        break;
      }
      case "model": {
        if (serveModeRef.current) {
          addMsg("  ⎿ cannot change model while serving (esc to stop first)", "#e3bd5a");
          break;
        }
        const tierArg = args[0];
        if (!tierArg) {
          setPickerActive(true);
          setPickerIdx(Math.max(0, models.findIndex((m) => m.tier === currentModelRef.current)));
        } else {
          // Accept short aliases ("haiku") as well as canonical tiers
          // ("claude-haiku") so the slash command matches what users
          // naturally type and what the README documents.
          const canonical = resolveTier(tierArg);
          const found = canonical ? models.find((m) => m.tier === canonical) : undefined;
          if (!found) addMsg(`Unknown model: ${tierArg}`, "#ff8888");
          else {
            setCurrentModelState(found.tier);
            await saveModelTier(found.tier);
            addMsg(`Model: ${found.display_name}  (${found.credits}cr/task)`, "#88ff88");
          }
        }
        break;
      }
      case "login": {
        if (pendingRef.current) {
          addMsg("  ⎿ task in flight; wait for it to finish.", "#e3bd5a");
          break;
        }
        if (serveModeRef.current) {
          addMsg("  ⎿ stop serve mode (esc) before logging in.", "#e3bd5a");
          break;
        }
        setLoginActive(true);
        break;
      }
      default: addMsg(`Unknown command: /${cmd}  (try /help)`, "#ff8888");
    }
  }, [addMsg, addMsgs, doExit, runRequest, enterServeMode, userId, username, swarm, models]);

  useInput((input, key) => {
    // Must remain the first check — LoginScreen's useInput fires after this one
    // (registration order), so Ctrl+C exits the app even while login is active.
    if (key.ctrl && input === "c") { doExit(); return; }

    // Serve mode: Esc requests stop (finish-then-exit if a task is running);
    // all other input is swallowed so typing/history nav doesn't interfere.
    if (serveModeRef.current) {
      if (key.escape) {
        const state = serveModeRef.current;
        if (!state.stopRequested) {
          state.stopRequested = true;
          if (state.active) {
            addMsg("  ⎿ finishing current task, then stopping…", "#e3bd5a");
            refreshServeDisplay();
          } else {
            addMsg(`─── serve mode stopped · ${state.completed} tasks processed ───`, "#00c8ff");
            serveModeRef.current = null;
            refreshServeDisplay();
          }
        }
      }
      return;
    }

    // LoginScreen owns its own useInput; prevent chat from also processing keys.
    if (loginActive) return;

    // Picker mode
    if (pickerActive) {
      if (key.upArrow) { setPickerIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setPickerIdx((i) => Math.min(models.length - 1, i + 1)); return; }
      if (key.escape) { setPickerActive(false); return; }
      if (key.return) {
        const m = models[pickerIdx];
        setPickerActive(false);
        setCurrentModelState(m.tier);
        saveModelTier(m.tier);
        addMsg(`Model: ${m.display_name}  (${m.credits}cr/task)`, "#88ff88");
        return;
      }
      return;
    }

    // Menu navigation
    if (menuItems.length > 0) {
      if (key.upArrow) { setMenuIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setMenuIdx((i) => Math.min(menuItems.length - 1, i + 1)); return; }
      if (key.tab) {
        const sel = menuItems[menuIdx];
        if (sel) {
          const newVal = "/" + sel.cmd;
          setInputVal(newVal);
          setCursorPos(newVal.length);
          setMenuItems([]);
          setMenuIdx(0);
        }
        return;
      }
      if (key.escape) { setMenuItems([]); setMenuIdx(0); return; }
    }

    // Cancel a waiting task (pre-match only). Keeps the chat session alive
    // so the user can immediately rephrase and retry.
    if (key.escape && pendingRef.current && !pendingRef.current.acceptorPeer) {
      pendingRef.current.cancel?.("user");
      return;
    }

    // History navigation
    if (key.upArrow) {
      setHistory((hist) => {
        setHistIdx((prev) => {
          const newIdx = Math.min(prev + 1, hist.length - 1);
          if (hist[newIdx] !== undefined) {
            setInputVal(hist[newIdx]);
            setCursorPos(hist[newIdx].length);
          }
          return newIdx;
        });
        return hist;
      });
      return;
    }
    if (key.downArrow) {
      setHistory((hist) => {
        setHistIdx((prev) => {
          if (prev <= 0) {
            setInputVal("");
            setCursorPos(0);
            return -1;
          }
          const newIdx = prev - 1;
          if (hist[newIdx] !== undefined) {
            setInputVal(hist[newIdx]);
            setCursorPos(hist[newIdx].length);
          }
          return newIdx;
        });
        return hist;
      });
      return;
    }

    if (key.return) {
      // Insert a newline instead of submitting when:
      //   - Shift+Enter or Alt/Option+Enter is pressed (terminals that report
      //     modifiers); or
      //   - the char immediately before the cursor is `\` (escape style —
      //     works in any terminal that doesn't report modifiers).
      // Plain Enter still submits.
      const backslashEscape = cursorPos > 0 && inputVal[cursorPos - 1] === "\\";
      if (key.shift || key.meta || backslashEscape) {
        setInputVal((v) => {
          const before = backslashEscape ? v.slice(0, cursorPos - 1) : v.slice(0, cursorPos);
          const after = v.slice(cursorPos);
          const newVal = before + "\n" + after;
          updateMenuItems(newVal);
          return newVal;
        });
        setCursorPos((p) => backslashEscape ? p : p + 1);
        return;
      }

      let raw: string;
      if (menuItems.length > 0) {
        raw = "/" + (menuItems[menuIdx]?.cmd ?? "");
        setMenuItems([]);
        setMenuIdx(0);
      } else {
        raw = inputVal.trim();
      }
      setInputVal("");
      setCursorPos(0);
      setHistIdx(-1);
      if (!raw) return;
      setHistory((h) => [raw, ...h]);
      dispatch(raw);
      return;
    }

    if (key.backspace || key.delete) {
      setInputVal((v) => {
        const newVal = v.slice(0, Math.max(0, cursorPos - 1)) + v.slice(cursorPos);
        updateMenuItems(newVal);
        return newVal;
      });
      setCursorPos((p) => Math.max(0, p - 1));
      return;
    }

    if (key.leftArrow) { setCursorPos((p) => Math.max(0, p - 1)); return; }
    if (key.rightArrow) { setCursorPos((p) => Math.min(inputVal.length, p + 1)); return; }

    if (input && !key.ctrl && !key.meta) {
      setInputVal((v) => {
        const newVal = v.slice(0, cursorPos) + input + v.slice(cursorPos);
        updateMenuItems(newVal);
        return newVal;
      });
      setCursorPos((p) => p + input.length);
    }
  });

  const updateMenuItems = (val: string) => {
    if (!val.startsWith("/")) { setMenuItems([]); setMenuIdx(0); return; }
    const q = val.slice(1).toLowerCase();
    const filtered = COMMANDS.filter((c) => c.cmd.startsWith(q));
    setMenuItems(filtered);
    setMenuIdx(0);
  };

  const statusDir = process.cwd().replace(homedir(), "~");
  const statusDirShort = statusDir.length > 40 ? "…" + statusDir.slice(-39) : statusDir;

  const inputLines = inputVal.length === 0 ? [""] : inputVal.split("\n");
  const beforeCursor = inputVal.slice(0, cursorPos);
  const cursorRow = beforeCursor.split("\n").length - 1;
  const cursorCol = stringWidth(beforeCursor.split("\n").pop() ?? "");

  const inflightLines = inflightStatus ? 1 : 0;

  // Menu/picker below input shifts the input up by their height.
  const menuHeight = (!loginActive && !serveDisplay)
    ? pickerActive
      ? Math.min(models.length, 11) + 1
      : menuItems.length
    : 0;

  // Static header = 6 rows. Dynamic area = termHeight - 6.
  // Fixed rows at bottom: input box (inputLines+2) + status bar (1) + menu + inflight.
  // Messages fill whatever remains at the top; slice by line count to match exactly.
  const HEADER_LINES = 6;
  const effectiveMsgWidth = Math.max(1, termWidth - 2);
  const msgBudget = Math.max(1,
    termHeight - HEADER_LINES - inputLines.length - 3 - menuHeight - inflightLines,
  );
  const countMsgLines = (msg: { text: string }) =>
    msg.text.length === 0 ? 0 :
    msg.text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(stringWidth(line) / effectiveMsgWidth)), 0);
  let usedLines = 0;
  const visibleMsgs: typeof msgs = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const l = countMsgLines(msgs[i]);
    if (usedLines + l > msgBudget) break;
    usedLines += l;
    visibleMsgs.unshift(msgs[i]);
  }
  if (visibleMsgs.length === 0 && msgs.length > 0) visibleMsgs.push(msgs[msgs.length - 1]);

  // Cursor y from top of dynamic section: messages + inflight + top-separator + cursorRow.
  // Menu is below the input so it doesn't shift the input's y position.
  const { setCursorPosition } = useCursor();
  if (!serveDisplay && !loginActive) {
    setCursorPosition({
      x: 3 + cursorCol,
      y: usedLines + inflightLines + 1 + cursorRow,
    });
  } else {
    setCursorPosition({ x: 0, y: 0 });
  }

  const SIG = "#00c8ff";
  const MX = 3;
  const boxW = Math.min(68, Math.max(30, termWidth - MX * 2));
  const hdrTitle = ` agent share v${CLIENT_VERSION} `;
  const topLine = `┏━━${hdrTitle}${"━".repeat(Math.max(0, boxW - 4 - hdrTitle.length))}┓`;
  const heavyBorder = { topLeft: "┏", top: "━", topRight: "┓", left: "┃", right: "┃", bottomLeft: "┗", bottom: "━", bottomRight: "┛" };

  // Static section holds only the header — messages live in the dynamic
  // section so /clear can wipe them without writing raw escape codes that
  // confuse Ink's cursor tracking.
  type StaticItem = { kind: "header" };
  const staticItems: StaticItem[] = [{ kind: "header" }];

  return (
    <>
      <Static items={staticItems}>
        {(item) => (
          <Box key="__header__" flexDirection="column" marginBottom={1}>
            <Box paddingLeft={MX}>
              <Text color={SIG}>{topLine}</Text>
            </Box>
            <Box marginX={MX} width={boxW} borderStyle={heavyBorder} borderTop={false} borderColor={SIG} paddingX={2} paddingY={0}>
              <Box flexDirection="column">
                <Text><Text color={SIG}>{"◆ ash"}</Text><Text color="#aaaaaa">{"  P2P agent share"}</Text></Text>
                <Text><Text color="#888888">{"username: "}</Text><Text color="#cccccc">{username}</Text></Text>
                <Text><Text color="#888888">{"directory: "}</Text><Text color="#cccccc">{statusDirShort}</Text></Text>
              </Box>
            </Box>
          </Box>
        )}
      </Static>

      <Box flexDirection="column">
        {/* Messages sliced by line count; no flexGrow so box sizes to content. */}
        <Box flexDirection="column">
          {visibleMsgs.map((msg) => (
            <Box key={msg.id} paddingX={1}>
              <Text color={msg.color}>{msg.text}</Text>
            </Box>
          ))}
        </Box>

        {/* In-flight task heartbeat: spinner + elapsed time. */}
        {inflightStatus && (() => {
          const elapsedS = Math.floor((Date.now() - inflightStatus.startTs) / 1000);
          const mm = Math.floor(elapsedS / 60);
          const ss = elapsedS % 60;
          const timeStr = mm > 0 ? `${mm}m ${String(ss).padStart(2, "0")}s` : `${ss}s`;
          return (
            <Box paddingX={1}>
              <Text color="#6b6b6b">
                {`  ${FRAMES[spinFrame]} running on ${inflightStatus.acceptorPubkey.slice(0, 8)}… · ${timeStr}`}
              </Text>
            </Box>
          );
        })()}

        {loginActive && (
          <LoginScreen
            onClose={(result: LoginResult | null) => {
              setLoginActive(false);
              if (!result) { addMsg("  ⎿ login cancelled.", "#888888"); return; }
              addMsg(`  ⎿ logged in: ${result.label}`, "#7cd38a");
            }}
          />
        )}

        {/* Input (or serve-mode status line in its place) */}
        {!loginActive && (serveDisplay ? (() => {
          let runningPart: string;
          if (serveDisplay.busy) {
            const sm = serveModeRef.current;
            const startTs = sm?.activeStartTs ?? Date.now();
            const elapsedS = Math.floor((Date.now() - startTs) / 1000);
            const mm = Math.floor(elapsedS / 60);
            const ss = elapsedS % 60;
            const timeStr = mm > 0 ? `${mm}m ${String(ss).padStart(2, "0")}s` : `${ss}s`;
            const lastLine = serveDisplay.lastLine ? `  ${serveDisplay.lastLine}` : "";
            runningPart = `${FRAMES[spinFrame]} running · ${timeStr}${lastLine}`;
          } else if (serveDisplay.stopping) {
            runningPart = "stopping after current…";
          } else {
            runningPart = "waiting for task…";
          }
          return (
            <Box flexDirection="column">
              <Text color="#888888">{"━".repeat(termWidth)}</Text>
              <Box paddingLeft={1} paddingRight={2} gap={1}>
                <Text color="#00c8ff">◆</Text>
                <Text color="#cccccc">
                  {`serve ${serveDisplay.modelTier}  · ${serveDisplay.completed}/${isFinite(serveDisplay.maxTasks) ? serveDisplay.maxTasks : "∞"}  · `}
                  <Text color={serveDisplay.busy ? "#7cd38a" : "#888888"}>
                    {runningPart}
                  </Text>
                  <Text color="#555555">
                    {serveDisplay.stopping ? "" : "  · esc to stop"}
                  </Text>
                </Text>
              </Box>
              <Text color="#888888">{"━".repeat(termWidth)}</Text>
            </Box>
          );
        })() : (
          <Box flexDirection="column">
            <Text color="#888888">{"━".repeat(termWidth)}</Text>
            <Box paddingLeft={1} paddingRight={2} gap={1} alignItems="flex-start">
              <Text color="#ffffff">❯</Text>
              <Box flexDirection="column">
                {inputVal.length === 0 && cursorPos === 0
                  ? <Text color="#555555">{"type a prompt, /help for commands"}</Text>
                  : inputLines.map((line, i) => (
                      <Text key={i} color="#ffffff">{line.length === 0 ? " " : line}</Text>
                    ))
                }
              </Box>
            </Box>
            <Text color="#888888">{"━".repeat(termWidth)}</Text>
          </Box>
        ))}

        {/* Slash-command menu / model picker — below input, inside fixed-height area. */}
        {!loginActive && !serveDisplay && menuItems.length > 0 && !pickerActive && (
          <Box flexDirection="column" paddingX={2}>
            {menuItems.map((c, i) => (
              <Box key={c.cmd}>
                <Text color={i === menuIdx ? "#ffffff" : "#888888"}
                      backgroundColor={i === menuIdx ? "#2a2a2a" : undefined}>
                  {`  /${c.cmd.padEnd(10)}  ${c.desc}`}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        {!loginActive && !serveDisplay && pickerActive && (
          <Box flexDirection="column" paddingX={2}>
            {models.slice(0, 11).map((m, i) => (
              <Box key={m.tier}>
                <Text color={i === pickerIdx ? "#ffffff" : "#888888"}
                      backgroundColor={i === pickerIdx ? "#2a2a2a" : undefined}>
                  {`  ${m.tier === currentModel ? "●" : " "} ${m.tier.padEnd(22)}  ${m.display_name.padEnd(24)}  ${String(m.credits).padStart(3)}cr`}
                </Text>
              </Box>
            ))}
            <Text color="#555555">{"    ↑↓ navigate · enter select · esc cancel"}</Text>
          </Box>
        )}

        {/* Status bar */}
        <Box height={1} paddingX={2}>
          <Text wrap="truncate-end">
            <Text color="#555555">model: </Text>
            <Text color="#4a9eff">{labelFor(currentModel)}</Text>
            <Text color="#888888">{` (${creditsFor(currentModel)}cr/task)`}</Text>
            <Text color="#555555">{"  balance: "}</Text>
            {syncing
              ? <Text color="#888888">syncing…</Text>
              : <Text color="#7cd38a">{balance}cr</Text>
            }
            <Text color="#555555">{"  served: "}</Text>
            <Text color="#7cd38a">{syncing ? "…" : String(served)}</Text>
            <Text color="#555555">{"  turn: "}</Text>
            <Text color="#cccccc">{turns.length}</Text>
            <Text color="#555555">{"  ctx: "}</Text>
            <Text color={ctxPct >= 80 ? "#ff8888" : ctxPct >= 50 ? "#e3bd5a" : "#7cd38a"}>{ctxPct}%</Text>
            <Text color="#555555">{"  peers: "}</Text>
            <Text color="#cccccc">{peerCount}</Text>
          </Text>
        </Box>
      </Box>
    </>
  );
}

export async function runChat(opts: { model?: string } = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("\n  ash requires an interactive terminal (TTY).\n  Run 'ash' directly in your terminal, not via a pipe.\n");
    process.exit(1);
  }
  // ink bundles a dev build of react-reconciler that calls performance.measure()
  // on every render without ever calling clearMeasures(). Long chat sessions
  // would hit Node's 1M-entry buffer cap and emit MaxPerformanceEntryBufferExceededWarning.
  const { performance } = await import("node:perf_hooks");
  setInterval(() => performance.clearMeasures(), 60_000).unref();

  const absDir = process.cwd();
  const cfg = await loadConfig();
  if (!cfg.pubkey || !cfg.username) {
    console.error("\n  Not initialized. Run: ash init\n");
    process.exit(1);
  }
  const userId: string = cfg.pubkey;
  const username: string = cfg.username;

  const { priv: edPriv } = await loadIdentity();
  await getOrCreateKeyPair(userId);

  const models: Model[] = await loadModels();
  let initialModel = opts.model ?? await loadModelTier();
  if (!models.find((m) => m.tier === initialModel)) initialModel = DEFAULT_MODEL_TIER;

  // From here on, the corestore is open. Any abort path must release the
  // lock so the next `ash` invocation isn't told the store is "locked".
  const exitWithCleanup = async (code: number): Promise<never> => {
    await closeLocalStore().catch(() => undefined);
    process.exit(code);
  };

  const swarm = new AshSwarm();

  // Join the task swarm before rendering so no early peer connection is missed
  // by ChatApp's onConnect handler.
  let joinError: Error | null = null;
  try {
    await swarm.join(edPriv, userId);
  } catch (err) {
    joinError = err as Error;
  }

  if (joinError) {
    const msg = joinError.message ?? "";
    if (msg.includes("could not be locked") || msg.includes("lock")) {
      console.error("\n  Another ash process is already running.\n  Stop it first, then run ash again.\n");
    } else {
      console.error(`\n  Failed to join network: ${msg}\n`);
    }
    await exitWithCleanup(1);
  }

  // Ledger replication and balance fetch run in the background so the chat UI
  // renders immediately. ChatApp awaits this promise and updates once ready.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let repSwarm: any = null;
  const setupPromise: Promise<{ balance: number; served: number }> = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { default: Hyperswarm } = (await import("hyperswarm")) as any;
      repSwarm = new Hyperswarm();
      const store = await getCorestore();
      if (ADMIN_LEDGER_KEY) {
        const ac = store.get(Buffer.from(ADMIN_LEDGER_KEY, "hex"), { valueEncoding: "utf-8" });
        await ac.ready().catch(() => {});
      }
      repSwarm.join(LEDGER_TOPIC);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repSwarm.on("connection", (conn: any) => store.replicate(conn));
      await Promise.race([repSwarm.flush(), new Promise<void>((r) => setTimeout(r, 5000))]);
      await new Promise<void>((r) => setTimeout(r, 2000));
    } catch (err) {
      if (err instanceof Error && err.message) {
        console.error("[ash] ledger replication swarm failed to start:", err.message);
      }
    }
    const balance = (await getLocalBalance(userId)).balance;
    const served = (await getEvents(userId)).filter((e) => e.type === "earn").length;
    return { balance, served };
  })();

  const { waitUntilExit } = render(
    <ChatApp
      userId={userId}
      username={username}
      edPriv={edPriv}
      models={models}
      initialModel={initialModel}
      initialBalance={0}
      initialServed={0}
      setupPromise={setupPromise}
      swarm={swarm}
      absDir={absDir}
    />,
    { exitOnCtrlC: false },
  );

  await waitUntilExit();
  await setupPromise.catch(() => {});
  await repSwarm?.destroy().catch(() => {});
  // Release the corestore handle on exit. Without this the file lock
  // can linger long enough that a second `ash` invocation in the next
  // shell sees "Corestore locked".
  await closeLocalStore().catch(() => undefined);
}
