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
import { scanDirectory, formatScanResults } from "../../core/packaging/secret_scanner.ts";
import { packDirectory } from "../../core/packaging/pack.ts";
import { applyPatch, getChangedFiles } from "../../core/diff/apply.ts";
import { signEd25519 } from "../../core/crypto/ed25519.ts";
import { canonicalStringify } from "../../shared/canonical.ts";
import {
  eventWithoutSignature,
  type EarnEvent,
  type SpendEvent,
} from "../../shared/events.ts";
import {
  appendLocalEvent,
  closeLocalStore,
  getLedgerCoreKey,
  getLocalBalance,
  getNextNonce,
} from "../p2p_state.ts";
import { getCorestore } from "../../core/ledger/store.ts";
import { getEvents, getAdminMintsFor } from "../../core/ledger/events.ts";
import { LEDGER_TOPIC } from "../../shared/constants.ts";
import { splitFee } from "../../shared/policy.ts";
import { AshSwarm, type SwarmPeer } from "../../core/p2p/swarm.ts";
import type { P2PMessage } from "../../core/p2p/messages.ts";
import type { Model } from "../../shared/types.ts";
import { DEFAULT_MODEL_TIER, modelToAgent } from "../../shared/types.ts";
import { CLIENT_VERSION } from "../../shared/protocol.ts";
import { validateAgentCredentials, ensureAgentLoggedIn } from "./init.ts";
import { AuthError, processTask, type ActiveTask } from "./serve.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COMMANDS = [
  { cmd: "serve",   desc: "accept tasks to earn  (e.g. /serve 5)" },
  { cmd: "model",   desc: "pick a model  (e.g. /model sonnet)" },
  { cmd: "new",     desc: "start a new conversation (clear turn history)" },
  { cmd: "status",  desc: "show account info" },
  { cmd: "peers",   desc: "list connected peers" },
  { cmd: "history", desc: "show event history  (e.g. /history <pubkey>)" },
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
  acceptorNextNonce: number;
  onMatchPending?: (peer: SwarmPeer, claimNonce: number, rsaPubPem: string) => Promise<void>;
  onLog?: (line: string) => void;
  onDiff?: (patch: string) => Promise<void>;
  resolveSettle?: (action: "approve" | "reject") => void;
  // Cancel the in-flight request (broadcasts task:cancel and ends the
  // runRequest promise). Only set while `runRequest` is waiting.
  cancel?: (reason?: "user" | "timeout") => void;
}

interface Turn {
  prompt: string;       // raw user prompt
  agentOutput: string;  // collected task:log lines
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
  activeLineCount: number;
}

interface ServeDisplay {
  modelTier: string;
  completed: number;
  maxTasks: number;
  stopping: boolean;
  busy: boolean;
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
  swarm: AshSwarm;
  absDir: string;
}

let _idCounter = 0;
const nextId = () => ++_idCounter;

function ChatApp({
  userId, username, edPriv, models, initialModel, initialBalance, initialServed, swarm, absDir,
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

  const [currentModel, setCurrentModelState] = useState(initialModel);
  const [balance, setBalance] = useState(initialBalance);
  const [served, setServed] = useState(initialServed);
  const [peerCount, setPeerCount] = useState(0);
  const [inflightStatus, setInflightStatus] = useState<{
    startTs: number;
    acceptorPubkey: string;
    lineCount: number;
  } | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef = useRef<Turn[]>([]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);

  const [spinFrame, setSpinFrame] = useState(0);

  const pendingRef = useRef<PendingTask | null>(null);
  const confirmResolveRef = useRef<((apply: boolean) => void) | null>(null);
  const currentModelRef = useRef(initialModel);
  const serveModeRef = useRef<ServeModeState | null>(null);
  const [serveDisplay, setServeDisplay] = useState<ServeDisplay | null>(null);

  useEffect(() => { currentModelRef.current = currentModel; }, [currentModel]);

  const refreshServeDisplay = useCallback(() => {
    const sm = serveModeRef.current;
    if (!sm) { setServeDisplay(null); return; }
    setServeDisplay({
      modelTier: sm.modelTier,
      completed: sm.completed,
      maxTasks: sm.maxTasks,
      stopping: sm.stopRequested,
      busy: sm.active !== null,
    });
  }, []);

  const addMsg = useCallback((text: string, color = "#cccccc") => {
    setMsgs((prev) => [...prev, { id: nextId(), text, color }]);
  }, []);

  const addMsgs = useCallback((lines: string[], color = "#cccccc") => {
    const newLines = lines.map((text) => ({ id: nextId(), text, color }));
    setMsgs((prev) => [...prev, ...newLines]);
  }, []);

  const updateLastMsg = useCallback((text: string) => {
    setMsgs((prev) => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = { ...updated[updated.length - 1], text };
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
    swarm.onConnect(() => {
      setPeerCount(swarm.getPeers().length);
      swarm.broadcast({
        type: "peer:info",
        pubkey: userId,
        username,
        model_tier: currentModelRef.current,
      });
    });
    swarm.onDisconnect(() => setPeerCount(swarm.getPeers().length));

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

      peer.send({
        type: "task:claim",
        task_id: announce.task_id,
        acceptor_pubkey: userId,
        rsa_public_key: state.rsaPubPem,
        next_nonce: nextNonce,
      });

      state.active = {
        taskId: announce.task_id,
        requesterPubkey: announce.requester_pubkey,
        prompt: announce.prompt,
        model: announce.model,
        peer,
      };
      state.activeStartTs = Date.now();
      state.activeLineCount = 0;
      refreshServeDisplay();

      const serveLogger = (raw: string): void => {
        // processTask emits ANSI-wrapped strings with trailing newlines; strip both
        // for Ink rendering. Lines that become empty after trim are dropped.
        const cleaned = raw.replace(/\x1b\[[0-9;]*m/g, "");
        for (const line of cleaned.split("\n")) {
          if (line.trim()) {
            addMsg(`    ${line}`, "#6b6b6b");
            state.activeLineCount += 1;
          }
        }
      };

      try {
        await ensureAgentLoggedIn(state.agent);
        await processTask(state.active, userId, state.modelTier, serveLogger);
        state.completed += 1;
        const bal = (await getLocalBalance(userId)).balance;
        setBalance(bal);
        setServed((n) => n + 1);
        const credits = models.find((m) => m.tier === state.modelTier)?.credits ?? 0;
        addMsg(
          `  ⎿ [${idx}/${cap}] task from ${who}…  → +${credits}cr  (balance: ${bal}cr)`,
          credits > 0 ? "#7cd38a" : "#6b6b6b",
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
        state.activeLineCount = 0;
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

    swarm.onMessage(async (peer, msg) => {
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
            case "spend:cosign":
              if (msg.task_id !== sm.active.taskId) return;
              sm.active.resolveSpend?.(msg.spend_event);
              return;
            case "earn:cosign":
              if (msg.task_id !== sm.active.taskId) return;
              sm.active.resolveEarn?.(msg.earn_event);
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
        case "task:claim":
          if (msg.task_id !== p.taskId) return;
          if (p.acceptorPeer) return;
          if (msg.acceptor_pubkey !== peer.pubkey) return; // reject spoofed acceptor identity
          p.acceptorPeer = peer;
          p.acceptorPubkey = msg.acceptor_pubkey;
          p.acceptorNextNonce = msg.next_nonce;
          await p.onMatchPending?.(peer, msg.next_nonce, msg.rsa_public_key);
          break;
        case "task:blob_request":
          if (msg.task_id !== p.taskId || peer.id !== p.acceptorPeer?.id) return;
          peer.send({ type: "task:blob", task_id: p.taskId, data: p.ciphertextB64 });
          break;
        case "task:log":
          if (msg.task_id !== p.taskId || peer.id !== p.acceptorPeer?.id) return;
          p.onLog?.(msg.line);
          break;
        case "task:diff":
          if (msg.task_id !== p.taskId || peer.id !== p.acceptorPeer?.id) return;
          await p.onDiff?.(msg.patch);
          break;
        case "task:settle":
          if (msg.task_id !== p.taskId || peer.id !== p.acceptorPeer?.id) return;
          p.resolveSettle?.(msg.action);
          break;
      }
    });
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
    return () => process.off("SIGTERM", doExit);
  }, [doExit]);

  const creditsFor = (t: string) => models.find((m) => m.tier === t)?.credits ?? 15;
  const labelFor   = (t: string) => models.find((m) => m.tier === t)?.display_name ?? t;

  const buildPromptWithHistory = (userPrompt: string): string => {
    const history = turnsRef.current;
    if (history.length === 0) return userPrompt;
    const parts: string[] = ["## Previous conversation in this session", ""];
    history.forEach((t, i) => {
      parts.push(`### Turn ${i + 1}`);
      parts.push(`User: ${t.prompt}`);
      parts.push("");
      parts.push("Agent output:");
      parts.push(t.agentOutput || "(no output)");
      parts.push("");
      parts.push(`Result: ${t.diffApplied ? "changes applied" : "no changes applied"}`);
      parts.push("");
    });
    parts.push("## Current turn");
    parts.push(userPrompt);
    return parts.join("\n");
  };

  const runRequest = useCallback(async (prompt: string) => {
    if (pendingRef.current) {
      addMsg("  ⎿ a task is already in flight; wait for it to finish.", "#e3bd5a");
      return;
    }
    addMsg(`❯ ${prompt}`, "#eaeaea");
    const cost = creditsFor(currentModelRef.current);
    const fullPrompt = buildPromptWithHistory(prompt);

    if (swarm.getPeers().length === 0) {
      addMsg("  ⎿ no peers connected; nobody can accept your task.", "#e3bd5a");
      return;
    }

    addMsg(`  ${FRAMES[0]} packaging…`, "#6b6b6b");

    const taskId = randomUUID();
    let aesKeyRaw: Uint8Array;
    let ciphertextB64: string;
    let ivB64: string;
    let blobSize = 0;

    try {
      const scan = await scanDirectory(absDir);
      if (scan.length > 0) {
        updateLastMsg("  ✗ sensitive info detected");
        addMsg(formatScanResults(scan), "#ff8888");
        return;
      }
      const { ciphertext, iv, aesKeyRaw: keyRaw } = await packDirectory(absDir);
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
      acceptorPeer: null, acceptorPubkey: null, acceptorNextNonce: 0,
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
    };
    swarm.broadcast(announce);
    addMsg(`  ⎿ announced  (${taskId.slice(0, 8)})`, "#6b6b6b");
    addMsg(`  ${FRAMES[0]} waiting for acceptor…  (esc to cancel)`, "#6b6b6b");

    let agentStarted = false;
    let agentBuffer = "";

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
            lineCount: 0,
          });
        } catch (err) {
          addMsg(`  ⎿ match failed: ${(err as Error).message}`, "#ff8888");
          finish();
        }
      };

      pendingRef.current!.onLog = (line) => {
        if (!agentStarted) {
          updateLastMsg("  ● agent");
          agentStarted = true;
        }
        addMsg(`   ${line}`, "#e8e8e8");
        agentBuffer += line + "\n";
        setInflightStatus((s) => s ? { ...s, lineCount: s.lineCount + 1 } : s);
      };

      pendingRef.current!.onDiff = async (patch) => {
        const p = pendingRef.current!;
        const fullCost = cost;
        const halfCost = Math.floor(cost / 2);
        const hasPatch = !!patch && patch.trim() !== "";

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
          for (const f of files) addMsg(`  ⎿ • ${f}`, "#6b6b6b");
          addMsg(`  ⎿ Apply? (y=${fullCost}cr · n=${halfCost}cr · 60s no reply = ${halfCost}cr)`, "#ffcc44");

          const decision = await new Promise<"y" | "n" | "timeout">((resolve) => {
            confirmResolveRef.current = (apply) => resolve(apply ? "y" : "n");
            setTimeout(() => resolve("timeout"), 60_000);
          });
          confirmResolveRef.current = null;

          if (decision === "y") {
            amount = fullCost;
            applyRequested = true;
            outcomeLabel = "applied";
          } else if (decision === "n") {
            amount = halfCost;
            outcomeLabel = "rejected";
          } else {
            amount = halfCost;
            outcomeLabel = "timeout";
          }
        }

        // Build spend event (always — even on half-charge / empty diff).
        const spendNonce = await getNextNonce(userId);
        const spendBase = {
          type: "spend" as const,
          nonce: spendNonce,
          timestamp: new Date().toISOString(),
          amount,
          task_id: taskId,
          counterparty_pubkey: p.acceptorPubkey ?? "",
          counterparty_task_signature: "",
          signer_pubkey: userId,
        };
        const spendEvt: SpendEvent = {
          ...spendBase,
          signature: signEd25519(canonicalStringify(eventWithoutSignature(spendBase as unknown as SpendEvent)), edPriv),
        };
        p.acceptorPeer?.send({ type: "spend:cosign", task_id: taskId, spend_event: spendEvt });

        // Wait for acceptor's task:settle decision.
        const settleAction = await new Promise<"approve" | "reject">((resolve) => {
          p.resolveSettle = resolve;
          setTimeout(() => resolve("reject"), 30_000);
        });
        p.resolveSettle = undefined;

        if (settleAction !== "approve") {
          // Acceptor rejected (e.g. auth error on their side) — no charge.
          addMsg("  ⎿ acceptor rejected · no credits charged", "#e3bd5a");
          finish();
          return;
        }

        // Apply patch if user said yes.
        let appliedOk = true;
        if (applyRequested && hasPatch) {
          const applied = await applyPatch(patch!, absDir);
          appliedOk = applied.success;
        }

        try {
          await appendLocalEvent(userId, spendEvt);
          setBalance((b) => b - amount);
        } catch (err) {
          addMsg(`  ⎿ local spend log failed: ${(err as Error).message}`, "#ff8888");
        }

        if (p.acceptorPubkey) {
          // SpendEvent.amount is gross; EarnEvent.amount is net after fee split.
          // FEE_BPS=0 today means netEarn === amount.
          const netEarn = splitFee(amount).acceptor;
          const earnBase = {
            type: "earn" as const,
            nonce: p.acceptorNextNonce,
            timestamp: new Date().toISOString(),
            amount: netEarn,
            task_id: taskId,
            counterparty_pubkey: userId,
            counterparty_task_signature: "",
            signer_pubkey: p.acceptorPubkey,
          };
          const earnEvt: EarnEvent = {
            ...earnBase,
            signature: signEd25519(canonicalStringify(eventWithoutSignature(earnBase as unknown as EarnEvent)), edPriv),
          };
          p.acceptorPeer?.send({ type: "earn:cosign", task_id: taskId, earn_event: earnEvt });
        }

        const label = applyRequested
          ? (appliedOk ? "patch applied" : "patch conflict")
          : outcomeLabel;
        const color = applyRequested && appliedOk ? "#7cd38a" : "#e3bd5a";
        addMsg(`  ⎿ ${label} · ${amount}cr spent`, color);

        // Save this turn to conversation history so the next task can
        // reference it via buildPromptWithHistory.
        const newTurn: Turn = {
          prompt,
          agentOutput: agentBuffer.trim(),
          diffApplied: applyRequested && appliedOk,
          cost: amount,
        };
        setTurns((prev) => [...prev, newTurn]);

        finish();
      };
    });
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
      addMsg(`  ⎿ ${agent} credentials missing or expired. Quit and run \`ash init\` to refresh.`, "#ff8888");
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
      activeLineCount: 0,
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
    switch (cmd.toLowerCase()) {
      case "q": case "quit": case "exit": doExit(); break;
      case "": case "help":
        addMsgs([
          "Commands:",
          "  /serve [N]        accept tasks (N = count; omit for unlimited)",
          "  /model            interactive model picker",
          "  /model <tier>     switch directly",
          "  /new              start a new conversation (clear turn history)",
          "  /status           show account info",
          "  /peers            list connected peers",
          "  /history          show event history",
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
      case "clear":
        setMsgs([]);
        break;
      case "status": {
        const b = (await getLocalBalance(userId)).balance;
        setBalance(b);
        addMsgs([
          `user:    ${username}`,
          `model:   ${labelFor(currentModelRef.current)}  (${creditsFor(currentModelRef.current)}cr/task)`,
          `balance: ${b} credits`,
          `served:  ${served} tasks`,
          `peers:   ${swarm.getPeers().length}`,
          `cwd:     ${process.cwd().replace(homedir(), "~")}`,
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
        let bal = 0;
        for (const evt of all) {
          const ts = evt.timestamp.slice(0, 19).replace("T", " ");
          if (evt.type === "earn") {
            bal += evt.amount;
            addMsg(`  ${ts}  earn   +${String(evt.amount).padStart(4)} cr  from ${evt.counterparty_pubkey.slice(0, 8)}…`, "#7cd38a");
          } else if (evt.type === "spend") {
            bal -= evt.amount;
            addMsg(`  ${ts}  spend  -${String(evt.amount).padStart(4)} cr  to   ${evt.counterparty_pubkey.slice(0, 8)}…`, "#e3bd5a");
          } else if (evt.type === "mint") {
            bal += evt.amount;
            addMsg(`  ${ts}  mint   +${String(evt.amount).padStart(4)} cr  admin  (${evt.reason})`, "#88ccff");
          }
        }
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
        const tierArg = args[0]?.toLowerCase();
        if (!tierArg) {
          setPickerActive(true);
          setPickerIdx(Math.max(0, models.findIndex((m) => m.tier === currentModelRef.current)));
        } else {
          const found = models.find((m) => m.tier === tierArg);
          if (!found) addMsg(`Unknown model: ${tierArg}`, "#ff8888");
          else {
            setCurrentModelState(tierArg);
            await saveModelTier(tierArg);
            addMsg(`Model: ${found.display_name}  (${found.credits}cr/task)`, "#88ff88");
          }
        }
        break;
      }
      default: addMsg(`Unknown command: /${cmd}  (try /help)`, "#ff8888");
    }
  }, [addMsg, addMsgs, doExit, runRequest, enterServeMode, userId, username, swarm, models]);

  useInput((input, key) => {
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

  const { setCursorPosition } = useCursor();

  const committedMsgs = msgs.length > 0 ? msgs.slice(0, -1) : [];
  const pendingMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;

  const statusDir = process.cwd().replace(homedir(), "~");
  const statusDirShort = statusDir.length > 40 ? "…" + statusDir.slice(-39) : statusDir;

  const inputDisplay = inputVal;

  const SIG = "#00c8ff";
  const MX = 3;
  const boxW = Math.min(68, Math.max(30, termWidth - MX * 2));
  const hdrTitle = ` agent share v${CLIENT_VERSION} `;
  const topLine = `┏━━${hdrTitle}${"━".repeat(Math.max(0, boxW - 4 - hdrTitle.length))}┓`;
  const heavyBorder = { topLeft: "┏", top: "━", topRight: "┓", left: "┃", right: "┃", bottomLeft: "┗", bottom: "━", bottomRight: "┛" };

  // Position real cursor inside the ❯ input line for macOS IME overlay.
  // Header is the first Static item, so y is relative to the dynamic area only.
  // Dynamic area layout (0-indexed):
  //   pendingMsg (0-1) + separator(1) + input ← cursor here + separator(1) + menu/picker + status
  const pendingLines = pendingMsg ? 1 : 0;
  const cursorDisplayX = stringWidth(inputVal.slice(0, cursorPos));
  if (!serveDisplay) {
    setCursorPosition({ x: 3 + cursorDisplayX, y: pendingLines + 1 });
  } else {
    setCursorPosition({ x: 0, y: 0 });
  }

  // Single Static items array — header first, then committed messages.
  // Matches Claude Code's pattern (see sourcemap REPL.tsx: messagesJSX = [logo, ...messages]).
  type StaticItem = { kind: "header" } | { kind: "msg"; msg: MsgLine };
  const staticItems: StaticItem[] = [
    { kind: "header" },
    ...committedMsgs.map((msg) => ({ kind: "msg" as const, msg })),
  ];

  return (
    <>
      <Static items={staticItems}>
        {(item) => {
          if (item.kind === "header") {
            return (
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
            );
          }
          return (
            <Box key={item.msg.id} paddingX={1}>
              <Text color={item.msg.color}>{item.msg.text}</Text>
            </Box>
          );
        }}
      </Static>

      <Box flexDirection="column">
        {/* Pending (last) message — dynamic, can be updated in place. */}
        {pendingMsg && (
          <Box paddingX={1}>
            <Text color={pendingMsg.color}>{pendingMsg.text}</Text>
          </Box>
        )}

        {/* In-flight task heartbeat: spinner + elapsed time + line count. */}
        {inflightStatus && (() => {
          const elapsedS = Math.floor((Date.now() - inflightStatus.startTs) / 1000);
          const mm = Math.floor(elapsedS / 60);
          const ss = elapsedS % 60;
          const timeStr = mm > 0 ? `${mm}m ${String(ss).padStart(2, "0")}s` : `${ss}s`;
          const lineStr = inflightStatus.lineCount > 0
            ? ` · ${inflightStatus.lineCount} line${inflightStatus.lineCount === 1 ? "" : "s"}`
            : "";
          return (
            <Box paddingX={1}>
              <Text color="#6b6b6b">
                {`  ${FRAMES[spinFrame]} running on ${inflightStatus.acceptorPubkey.slice(0, 8)}… · ${timeStr}${lineStr}`}
              </Text>
            </Box>
          );
        })()}

        {/* Input (or serve-mode status line in its place) */}
        {serveDisplay ? (() => {
          let runningPart: string;
          if (serveDisplay.busy) {
            const sm = serveModeRef.current;
            const startTs = sm?.activeStartTs ?? Date.now();
            const lineCount = sm?.activeLineCount ?? 0;
            const elapsedS = Math.floor((Date.now() - startTs) / 1000);
            const mm = Math.floor(elapsedS / 60);
            const ss = elapsedS % 60;
            const timeStr = mm > 0 ? `${mm}m ${String(ss).padStart(2, "0")}s` : `${ss}s`;
            const lineStr = lineCount > 0 ? ` · ${lineCount} line${lineCount === 1 ? "" : "s"}` : "";
            runningPart = `${FRAMES[spinFrame]} running · ${timeStr}${lineStr}`;
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
            <Box paddingLeft={1} paddingRight={2} gap={1}>
              <Text color="#ffffff">❯</Text>
              <Text color="#ffffff">{inputVal.length === 0 && cursorPos === 0
                ? <Text color="#555555">{"type a prompt, /help for commands"}</Text>
                : inputDisplay
              }</Text>
            </Box>
            <Text color="#888888">{"━".repeat(termWidth)}</Text>
          </Box>
        )}

        {/* Slash-command menu (below input) */}
        {!serveDisplay && menuItems.length > 0 && !pickerActive && (
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

        {/* Model picker (below input) */}
        {!serveDisplay && pickerActive && (
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
            <Text color="#7cd38a">{balance}cr</Text>
            <Text color="#555555">{"  served: "}</Text>
            <Text color="#7cd38a">{served}</Text>
            <Text color="#555555">{"  turn: "}</Text>
            <Text color="#cccccc">{turns.length}</Text>
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

  const initialBalance = (await getLocalBalance(userId)).balance;
  const initialServed = (await getEvents(userId)).filter((e) => e.type === "earn").length;

  const swarm = new AshSwarm();
  try {
    await swarm.join(edPriv, userId);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("could not be locked") || msg.includes("lock")) {
      console.error("\n  Another ash process is already running.\n  Stop it first, then run ash again.\n");
    } else {
      console.error(`\n  Failed to join network: ${msg}\n`);
    }
    process.exit(1);
  }

  // Attach Corestore replication on the ledger topic so this node's event
  // Hypercore is available to serve peers for balance verification.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let repSwarm: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { default: Hyperswarm } = (await import("hyperswarm")) as any;
    repSwarm = new Hyperswarm();
    const store = await getCorestore();
    repSwarm.join(LEDGER_TOPIC);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repSwarm.on("connection", (conn: any) => store.replicate(conn));
  } catch (err) {
    console.error("[ash] ledger replication swarm failed to start:", (err as Error).message);
  }

  const { waitUntilExit } = render(
    <ChatApp
      userId={userId}
      username={username}
      edPriv={edPriv}
      models={models}
      initialModel={initialModel}
      initialBalance={initialBalance}
      initialServed={initialServed}
      swarm={swarm}
      absDir={absDir}
    />,
    { exitOnCtrlC: false },
  );

  await waitUntilExit();
  await repSwarm?.destroy().catch(() => {});
}
