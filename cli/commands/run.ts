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
  getRemotePeerBalance,
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
import { CHUNK_BYTES } from "../../shared/protocol.ts";
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
    let acceptorLedgerKey: string | null = null;
    let resolveSettle: ((msg: { action: "approve" | "reject"; requester_checkpoint_cosig?: string; acceptor_earn_checkpoint?: EarnCheckpointEvent }) => void) | null = null;

    swarm.onMessage(async (peer, msg) => {
      switch (msg.type) {
        case "task:claim": {
          if (msg.task_id !== taskId || acceptorPeer) return;
          if (msg.acceptor_pubkey !== peer.pubkey) return; // reject spoofed acceptor identity
          acceptorPeer = peer;
          acceptorPubkey = msg.acceptor_pubkey;
          acceptorLedgerKey = msg.acceptor_ledger_key ?? null;
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
          const chunkB64 = Math.ceil(CHUNK_BYTES * 4 / 3);
          const totalChunks = Math.ceil(ciphertextB64.length / chunkB64);
          for (let i = 0; i < totalChunks; i++) {
            peer.send({
              type: "task:blob_chunk",
              task_id: taskId,
              index: i,
              total: totalChunks,
              data: ciphertextB64.slice(i * chunkB64, (i + 1) * chunkB64),
            });
          }
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
          resolveSettle?.({ action: msg.action, requester_checkpoint_cosig: msg.requester_checkpoint_cosig, acceptor_earn_checkpoint: msg.acceptor_earn_checkpoint });
          break;
        }
        case "task:cancel": {
          if (msg.task_id !== taskId || peer.id !== acceptorPeer?.id) return;
          console.error("  acceptor cancelled task");
          await cleanup(1);
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
          balance: currentBalance - cost,
          amount: cost,
          task_id: taskId,
          counterparty_pubkey: acceptorPubkey ?? "",
          owner_pubkey: userId,
          sig_counterparty: "",
        };
        const spendCheckpoint: SpendCheckpointEvent = {
          ...spendCheckpointBase,
          signature: signEd25519(canonicalStringify(checkpointPayload(spendCheckpointBase as SpendCheckpointEvent)), edPriv),
        };
        acceptorPeer?.send({ type: "spend:cosign", task_id: taskId, spend_checkpoint: spendCheckpoint });

        const settleMsg = await new Promise<{ action: "approve" | "reject"; requester_checkpoint_cosig?: string; acceptor_earn_checkpoint?: EarnCheckpointEvent }>((resolve) => {
          let done = false;
          const settle = (v: { action: "approve" | "reject"; requester_checkpoint_cosig?: string; acceptor_earn_checkpoint?: EarnCheckpointEvent }) => {
            if (done) return;
            done = true;
            clearTimeout(t);
            resolve(v);
          };
          resolveSettle = settle;
          const t = setTimeout(() => settle({ action: "reject" }), 30_000);
        });
        resolveSettle = null;

        if (settleMsg.action !== "approve") throw new Error("rejected");

        const cosig = settleMsg.requester_checkpoint_cosig;
        if (!cosig) throw new Error("missing-cosig");

        // Verify acceptor's Ed25519 cosignature over our spend checkpoint payload.
        const cosigOk = acceptorPubkey
          ? verifyEd25519(
              canonicalStringify(checkpointPayload(spendCheckpoint)),
              cosig,
              rawHexToPublicKey(acceptorPubkey),
            )
          : false;
        if (!cosigOk) throw new Error("cosig-invalid");

        // Validate earn checkpoint BEFORE spend append (settlement ordering).
        // Hard-reject if ledger key missing or replication fails — mirrors the
        // acceptor-side balanceLookupOk pattern (C-2/C-3 fix).
        const aec = settleMsg.acceptor_earn_checkpoint;
        if (!aec) throw new Error("earn-missing");
        if (!acceptorLedgerKey) throw new Error("earn-no-ledger-key");
        const expectedAcceptorEarn = splitFee(cost).acceptor;
        let earnLookupOk = false;
        let prevAcceptorBalance = 0;
        let acceptorCoreLength = -1;
        try {
          const aecInfo = await getRemotePeerBalance(acceptorLedgerKey, acceptorPubkey!);
          prevAcceptorBalance = aecInfo.balance;
          acceptorCoreLength = aecInfo.coreLength;
          earnLookupOk = true;
        } catch { /* replication failed — hard reject */ }
        let aecSigOk = false;
        try {
          aecSigOk = verifyEd25519(
            canonicalStringify(checkpointPayload(aec)),
            aec.signature,
            rawHexToPublicKey(acceptorPubkey!),
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
          aec.owner_pubkey === acceptorPubkey &&
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
          console.log("  acceptor rejected · patch discarded");
        } else if (msg === "missing-cosig") {
          console.log("  acceptor missing spend cosig — no credits charged");
        } else if (msg === "cosig-invalid") {
          console.log("  acceptor spend cosig invalid — no credits charged");
        } else if (msg === "earn-missing" || msg === "earn-no-ledger-key" || msg === "earn-invalid") {
          console.log("  acceptor earn checkpoint invalid — no earn cosign sent");
        } else {
          console.error(`  local spend log failed: ${msg}`);
        }
      });

      if (!spendSettled) {
        await cleanup(0);
        return;
      }

      // Earn checkpoint was validated inside the spend mutex — just cosign and send.
      // Send BEFORE applyPatch so the acceptor's 30s earn:cosign window is not
      // consumed by local filesystem I/O (large patches can take several seconds).
      if (acceptorPubkey && settleEarnCheckpoint) {
        const earnCosig = signEd25519(canonicalStringify(checkpointPayload(settleEarnCheckpoint)), edPriv);
        acceptorPeer?.send({
          type: "earn:cosign",
          task_id: taskId,
          acceptor_checkpoint_cosig: earnCosig,
          acceptor_earn_checkpoint: settleEarnCheckpoint,
        });
      }

      const applied = await applyPatch(patch, absDir);

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
      credit_cost: cost,
    };
    swarm.broadcast(announce);

    // Re-announce to peers that connect after the initial broadcast so that
    // a serve node started after ash run still receives the task.
    swarm.onConnect((peer) => {
      if (!acceptorPeer) peer.send(announce);
    });

    console.log(`  announced  (${taskId.slice(0, 8)})  waiting for acceptor…`);
  });
