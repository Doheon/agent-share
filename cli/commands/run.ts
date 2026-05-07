/**
 * ash run "<prompt>" — one-shot task request without TUI.
 *
 * Packs the cwd, announces the task to the P2P network, streams agent logs
 * to stdout, and applies the resulting diff. No interactive UI.
 */

import { Command } from "commander";
import { confirm } from "@inquirer/prompts";
import { randomUUID } from "node:crypto";
import {
  loadConfig,
  loadIdentity,
  loadModels,
  loadModelTier,
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
  getLocalBalance,
  getNextNonce,
  getLedgerCoreKey,
  reservePendingSpend,
  releasePendingSpend,
  getSpendableBalance,
} from "../p2p_state.ts";
import { getCorestore } from "../../core/ledger/store.ts";
import { LEDGER_TOPIC, ADMIN_LEDGER_KEY } from "../../shared/constants.ts";
import { AshSwarm, type SwarmPeer } from "../../core/p2p/swarm.ts";
import type { P2PMessage } from "../../core/p2p/messages.ts";
import { sanitizeLogLine } from "../../core/p2p/messages.ts";
import { DEFAULT_MODEL_TIER } from "../../shared/types.ts";
import { splitFee } from "../../shared/policy.ts";
import { ensureInitialized, NotInitializedError } from "../guard.ts";

export const runCommand = new Command("run")
  .description("Send a one-shot prompt to the P2P network and apply the result")
  .argument("<prompt>", "Task prompt to send")
  .option("--model <tier>", "Model tier override")
  .action(async (prompt: string, opts: { model?: string }) => {
    try {
      await ensureInitialized();
    } catch (err) {
      if (err instanceof NotInitializedError) {
        console.error(`\nerror: ${err.reason}\n  → ${err.hint}\n`);
        process.exit(2);
      }
      throw err;
    }

    const absDir = process.cwd();
    const cfg = await loadConfig();
    const userId = cfg.pubkey!;

    const { priv: edPriv } = await loadIdentity();
    await getOrCreateKeyPair(userId);

    const models = await loadModels();
    let modelTier = opts.model ?? await loadModelTier();
    if (!models.find((m) => m.tier === modelTier)) modelTier = DEFAULT_MODEL_TIER;
    const cost = models.find((m) => m.tier === modelTier)?.credits ?? 15;

    // Brief LEDGER_TOPIC join to pull admin/counterparty core blocks so
    // getSpendableBalance sees the real balance on cold cache.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let prefetchSwarm: any = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { default: Hyperswarm } = (await import("hyperswarm")) as any;
      prefetchSwarm = new Hyperswarm();
      const prefetchStore = await getCorestore();
      if (ADMIN_LEDGER_KEY) {
        const ac = prefetchStore.get(Buffer.from(ADMIN_LEDGER_KEY, "hex"), { valueEncoding: "utf-8" });
        await ac.ready().catch(() => {});
      }
      prefetchSwarm.join(LEDGER_TOPIC);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prefetchSwarm.on("connection", (conn: any) => prefetchStore.replicate(conn));
      await Promise.race([prefetchSwarm.flush(), new Promise<void>((r) => setTimeout(r, 5000))]);
      await new Promise<void>((r) => setTimeout(r, 2000));
    } catch { /* non-fatal */ }
    await prefetchSwarm?.destroy().catch(() => {});

    // Pre-flight balance check using the spendable view (replayed minus
    // any in-flight reservations from concurrent flows in this process).
    // Without this, two concurrent `ash run` invocations could each see
    // the full balance and over-spend.
    const spendable = await getSpendableBalance(userId);
    if (spendable < cost) {
      console.error(`\n  Insufficient credits: need ${cost}, have ${spendable} spendable.\n`);
      await closeLocalStore().catch(() => undefined);
      process.exit(1);
    }
    reservePendingSpend(userId, cost);
    let reservationLive = true;
    const releaseReservation = () => {
      if (!reservationLive) return;
      reservationLive = false;
      releasePendingSpend(userId, cost);
    };

    const swarm = new AshSwarm();
    try {
      await swarm.join(edPriv, userId);
    } catch (err) {
      console.error(`\n  Failed to join P2P network: ${(err as Error).message}\n`);
      await closeLocalStore().catch(() => undefined);
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
      if (ADMIN_LEDGER_KEY) {
        const ac = store.get(Buffer.from(ADMIN_LEDGER_KEY, "hex"), { valueEncoding: "utf-8" });
        await ac.ready().catch(() => {});
      }
      repSwarm.join(LEDGER_TOPIC);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repSwarm.on("connection", (conn: any) => store.replicate(conn));
      await Promise.race([repSwarm.flush(), new Promise<void>((r) => setTimeout(r, 5000))]);
    } catch {
      // Non-fatal — balance propagation will be delayed but tasks still work.
    }

    const cleanup = async (code = 0) => {
      releaseReservation();
      await repSwarm?.destroy().catch(() => {});
      await swarm.destroy().catch(() => undefined);
      await closeLocalStore().catch(() => undefined);
      process.exit(code);
    };
    process.on("SIGINT", () => cleanup(0));
    process.on("SIGTERM", () => cleanup(0));

    // Wait up to 12s for at least one peer.
    process.stdout.write("  connecting to network…");
    const PEER_TIMEOUT = 12000;
    const PEER_POLL = 500;
    let waited = 0;
    while (swarm.getPeers().length === 0 && waited < PEER_TIMEOUT) {
      await new Promise<void>((resolve) => setTimeout(resolve, PEER_POLL));
      waited += PEER_POLL;
      process.stdout.write(".");
    }
    process.stdout.write("\n");
    if (swarm.getPeers().length === 0) {
      console.error("  No peers connected. Start an acceptor with: ash serve");
      await cleanup(1);
      return;
    }

    // Generate task identity *before* packing so the AES-GCM AAD binds the
    // ciphertext to (taskId, requesterPubkey). Any swap of ciphertexts
    // between concurrent tasks will fail authenticated decryption.
    const taskId = randomUUID();
    const aad = buildTaskAad(taskId, userId);

    // Pack.
    let ciphertextB64: string;
    let ivB64: string;
    let aesKeyRaw: Uint8Array;
    let blobSize: number;
    try {
      const { ciphertext, iv, aesKeyRaw: keyRaw } = await packDirectory(absDir, aad);
      aesKeyRaw = keyRaw;
      ciphertextB64 = Buffer.from(ciphertext).toString("base64");
      ivB64 = Buffer.from(iv).toString("base64");
      blobSize = ciphertext.length;
    } catch (err) {
      console.log("✗");
      console.error(`  ${(err as Error).message}`);
      await cleanup(1);
      return;
    }
    console.log(`✓  (${(blobSize! / 1024).toFixed(1)} KB)`);

    const myRsa = await getOrCreateKeyPair(userId);
    const myRsaPubPem = await exportPublicKeyPem(myRsa.publicKey);

    let acceptorPeer: SwarmPeer | null = null;
    let acceptorPubkey: string | null = null;
    let acceptorNextNonce = 0;
    let resolveSettle: ((action: "approve" | "reject") => void) | null = null;

    swarm.onMessage(async (peer, msg) => {
      switch (msg.type) {
        case "task:claim": {
          if (msg.task_id !== taskId || acceptorPeer) return;
          if (msg.acceptor_pubkey !== peer.pubkey) return; // reject spoofed acceptor identity
          acceptorPeer = peer;
          acceptorPubkey = msg.acceptor_pubkey;
          acceptorNextNonce = msg.next_nonce;
          try {
            const acceptorPub = await importPublicKeyPem(msg.rsa_public_key);
            const encAes = await encryptAesKey(aesKeyRaw!, acceptorPub);
            peer.send({ type: "task:match", task_id: taskId, encrypted_aes_key: encAes, blob_iv: ivB64 });
            console.log("  matched · running…");
          } catch (err) {
            console.error(`  match failed: ${(err as Error).message}`);
            await cleanup(1);
          }
          break;
        }
        case "task:blob_request": {
          if (msg.task_id !== taskId || peer.id !== acceptorPeer?.id) return;
          peer.send({ type: "task:blob", task_id: taskId, data: ciphertextB64 });
          break;
        }
        case "task:log": {
          if (msg.task_id !== taskId || peer.id !== acceptorPeer?.id) return;
          process.stdout.write("  " + sanitizeLogLine(msg.line) + "\n");
          break;
        }
        case "task:diff": {
          if (msg.task_id !== taskId || peer.id !== acceptorPeer?.id) return;
          await handleDiff(msg.patch);
          break;
        }
        case "task:settle": {
          if (msg.task_id !== taskId || peer.id !== acceptorPeer?.id) return;
          resolveSettle?.(msg.action);
          break;
        }
      }
    });

    const handleDiff = async (patch: string) => {
      if (!patch || patch.trim() === "") {
        acceptorPeer?.send({ type: "task:cancel", task_id: taskId });
        console.log("  no changes · task rejected");
        await cleanup(0);
        return;
      }

      const files = getChangedFiles(patch);
      const insertions = (patch.match(/^\+[^+]/gm) ?? []).length;
      const deletions  = (patch.match(/^-[^-]/gm) ?? []).length;
      console.log(`\n  ${files.length} file(s) changed  +${insertions} / -${deletions}`);
      for (const f of files) console.log(`    • ${f}`);

      const shouldApply = await confirm({ message: "Apply these changes?" });
      if (!shouldApply) {
        acceptorPeer?.send({ type: "task:cancel", task_id: taskId });
        console.log("  rejected · patch discarded");
        await cleanup(0);
        return;
      }

      // Build spend event and send to acceptor for validation.
      const spendNonce = await getNextNonce(userId);
      const spendBase = {
        type: "spend" as const,
        nonce: spendNonce,
        timestamp: new Date().toISOString(),
        amount: cost,
        task_id: taskId,
        counterparty_pubkey: acceptorPubkey ?? "",
        counterparty_task_signature: "",
        signer_pubkey: userId,
      };
      const spendEvt: SpendEvent = {
        ...spendBase,
        signature: signEd25519(canonicalStringify(eventWithoutSignature(spendBase as unknown as SpendEvent)), edPriv),
      };
      acceptorPeer?.send({ type: "spend:cosign", task_id: taskId, spend_event: spendEvt });

      // Wait for acceptor's task:settle decision.
      const settleAction = await new Promise<"approve" | "reject">((resolve) => {
        let done = false;
        const settle = (v: "approve" | "reject") => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(v);
        };
        resolveSettle = settle;
        const t = setTimeout(() => settle("reject"), 30_000);
      });
      resolveSettle = null;

      if (settleAction !== "approve") {
        console.log("  acceptor rejected · patch discarded");
        await cleanup(0);
        return;
      }

      const applied = await applyPatch(patch, absDir);
      try {
        await appendLocalEvent(userId, spendEvt);
      } catch (err) {
        console.error(`  local spend log failed: ${(err as Error).message}`);
      }

      if (acceptorPubkey) {
        // SpendEvent.amount is gross; EarnEvent.amount is net after fee split.
        // When FEE_BPS=0 these are identical. When FEE_BPS>0 the treasury share
        // is currently implicit — a future admin co-signed MintEvent will
        // materialize it on-log. Until then the fee math is reserved by the
        // difference (requester pays gross, acceptor receives net).
        const netEarn = splitFee(cost).acceptor;
        const earnBase = {
          type: "earn" as const,
          nonce: acceptorNextNonce,
          timestamp: new Date().toISOString(),
          amount: netEarn,
          task_id: taskId,
          counterparty_pubkey: userId,
          counterparty_task_signature: "",
          signer_pubkey: acceptorPubkey,
        };
        const earnEvt: EarnEvent = {
          ...earnBase,
          signature: signEd25519(canonicalStringify(eventWithoutSignature(earnBase as unknown as EarnEvent)), edPriv),
        };
        acceptorPeer?.send({ type: "earn:cosign", task_id: taskId, earn_event: earnEvt });
      }

      console.log(`\n  ${applied.success ? "patch applied" : "patch conflict"} · ${cost}cr spent`);
      await cleanup(0);
    };

    // Announce task.
    const requesterLedgerKey = await getLedgerCoreKey(userId).catch(() => undefined);
    const announce: P2PMessage = {
      type: "task:announce",
      task_id: taskId,
      prompt,
      model: modelTier,
      blob_size: blobSize!,
      requester_pubkey: userId,
      rsa_public_key: myRsaPubPem,
      timestamp: new Date().toISOString(),
      requester_ledger_key: requesterLedgerKey,
    };
    swarm.broadcast(announce);

    // Re-announce to peers that connect after the initial broadcast so that
    // a serve node started after ash run still receives the task.
    swarm.onConnect((peer) => {
      if (!acceptorPeer) peer.send(announce);
    });

    console.log(`  announced  (${taskId.slice(0, 8)})  waiting for acceptor…`);
  });
