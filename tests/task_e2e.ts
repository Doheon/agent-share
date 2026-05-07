/**
 * End-to-end task flow test.
 *
 * Two in-process AshSwarm instances run the full task protocol:
 *   announce → claim → match (real RSA key exchange) → blob_request
 *   → blob (real AES-encrypted directory) → (stub agent) → log → settle
 *
 * Uses @hyperswarm/testnet for a local DHT cluster (no internet required).
 *
 * Usage: node --import tsx/esm tests/task_e2e.ts
 */
process.env.ASH_DB = ":memory:";

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import createTestnet from "@hyperswarm/testnet";
import { AshSwarm } from "../core/p2p/swarm.ts";
import { generateEd25519KeyPair, publicKeyToRawHex } from "../core/crypto/ed25519.ts";
import { generateKeyPair, exportPublicKeyPem, encryptAesKey, decryptAesKey } from "../core/crypto/rsa.ts";
import { packDirectory } from "../core/packaging/pack.ts";
import { unpackToDirectory } from "../core/packaging/unpack.ts";
import { buildTaskAad } from "../core/crypto/aes.ts";
import type { P2PMessage } from "../core/p2p/messages.ts";

const TIMEOUT_MS = 45_000;
const ROOT = join(tmpdir(), `ash-e2e-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });

function log(tag: string, msg: string) {
  process.stdout.write(`[${tag}] ${msg}\n`);
}

// ── Identities ────────────────────────────────────────────────────────────────
const kpReq  = generateEd25519KeyPair();
const pubReq = publicKeyToRawHex(kpReq.publicKey);
const kpAcc  = generateEd25519KeyPair();
const pubAcc = publicKeyToRawHex(kpAcc.publicKey);

const rsaAcc  = await generateKeyPair();
const rsaPubPem = await exportPublicKeyPem(rsaAcc.publicKey);

// ── Testnet + Swarms ──────────────────────────────────────────────────────────
const testnet = await createTestnet(3);

const swarmAcc = new AshSwarm();  // acceptor
const swarmReq = new AshSwarm();  // requester

await swarmAcc.join(kpAcc.privateKey, pubAcc, { bootstrap: testnet.bootstrap });
log("Acc", "joined");

await swarmReq.join(kpReq.privateKey, pubReq, { bootstrap: testnet.bootstrap });
log("Req", "joined");

// Wait for both to see each other via DHT discovery.
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout waiting for peers")), TIMEOUT_MS);
  const tick = setInterval(() => {
    if (swarmAcc.getPeers().length > 0 && swarmReq.getPeers().length > 0) {
      clearInterval(tick); clearTimeout(t); resolve();
    }
  }, 100);
});
log("Acc", `peers=${swarmAcc.getPeers().length}`);
log("Req", `peers=${swarmReq.getPeers().length}`);

// ── Pack a real task directory ────────────────────────────────────────────────
const taskDir = join(ROOT, "task-src");
mkdirSync(taskDir, { recursive: true });
writeFileSync(join(taskDir, "prompt.txt"), "Say hello in one word.\n");

const TASK_ID = randomUUID();
const aad = buildTaskAad(TASK_ID, pubReq);
const { ciphertext, iv, aesKeyRaw } = await packDirectory(taskDir, aad);
const ciphertextB64 = Buffer.from(ciphertext).toString("base64");
const ivB64 = Buffer.from(iv).toString("base64");
log("Req", `packed blob  size=${ciphertext.length}B`);

// ── State tracking ────────────────────────────────────────────────────────────
let settleAction: string | null = null;
let logLines: string[] = [];
const resolvers: Record<string, () => void> = {};
const done: Record<string, boolean> = {};
function waitFor(key: string) {
  return new Promise<void>((resolve, reject) => {
    if (done[key]) { resolve(); return; }
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${key}`)), TIMEOUT_MS);
    resolvers[key] = () => { clearTimeout(t); resolve(); };
  });
}
function signal(key: string) {
  done[key] = true;
  resolvers[key]?.();
}

// ── Acceptor message handler ──────────────────────────────────────────────────
swarmAcc.onMessage(async (peer: import("../core/p2p/swarm.ts").SwarmPeer, msg: P2PMessage) => {
  switch (msg.type) {
    case "task:announce": {
      if (msg.task_id !== TASK_ID) return;
      log("Acc", "received task:announce — sending task:claim");
      peer.send({
        type: "task:claim",
        task_id: TASK_ID,
        acceptor_pubkey: pubAcc,
        rsa_public_key: rsaPubPem,
        next_nonce: 1,
      });
      break;
    }

    case "task:match": {
      if (msg.task_id !== TASK_ID) return;
      log("Acc", "received task:match — decrypting AES key, sending blob_request");
      const aesKeyBytes = await decryptAesKey(msg.encrypted_aes_key, rsaAcc.privateKey);
      signal("aes_key_received");
      (swarmAcc as any)._testAesKey = aesKeyBytes;
      (swarmAcc as any)._testBlobIv = msg.blob_iv;
      peer.send({ type: "task:blob_request", task_id: TASK_ID });
      break;
    }

    case "task:blob": {
      if (msg.task_id !== TASK_ID) return;
      log("Acc", `received task:blob  size=${(msg as any).data?.length}B`);

      const accAesKey = (swarmAcc as any)._testAesKey as Uint8Array;
      const accBlobIv = (swarmAcc as any)._testBlobIv as string;
      const ciphertextBytes = new Uint8Array(Buffer.from((msg as any).data, "base64"));
      const ivBytes = new Uint8Array(Buffer.from(accBlobIv, "base64"));
      const workDir = join(ROOT, "task-work");
      mkdirSync(workDir, { recursive: true });
      await unpackToDirectory(ciphertextBytes, accAesKey, ivBytes, workDir, aad);
      log("Acc", "blob decrypted + unpacked");

      writeFileSync(join(workDir, "result.txt"), "Hello!\n");

      peer.send({ type: "task:log", task_id: TASK_ID, line: "stub agent: done" });
      peer.send({ type: "task:settle", task_id: TASK_ID, action: "approve" });
      signal("blob_received");
      break;
    }
  }
});

// ── Requester message handler ─────────────────────────────────────────────────
swarmReq.onMessage(async (peer: import("../core/p2p/swarm.ts").SwarmPeer, msg: P2PMessage) => {
  switch (msg.type) {
    case "task:claim": {
      if (msg.task_id !== TASK_ID) return;
      if (msg.acceptor_pubkey !== peer.pubkey) {
        log("Req", "WARN: spoofed acceptor_pubkey — ignoring");
        return;
      }
      log("Req", "received task:claim — encrypting AES key, sending task:match");
      const acceptorPub = await (await import("../core/crypto/rsa.ts")).importPublicKeyPem(msg.rsa_public_key);
      const encAes = await encryptAesKey(aesKeyRaw, acceptorPub);
      peer.send({
        type: "task:match",
        task_id: TASK_ID,
        encrypted_aes_key: encAes,
        blob_iv: ivB64,
      });
      break;
    }

    case "task:blob_request": {
      if (msg.task_id !== TASK_ID) return;
      log("Req", "received task:blob_request — sending blob");
      peer.send({ type: "task:blob", task_id: TASK_ID, data: ciphertextB64 } as P2PMessage);
      break;
    }

    case "task:log": {
      if (msg.task_id !== TASK_ID) return;
      logLines.push(msg.line);
      log("Req", `task:log  "${msg.line}"`);
      break;
    }

    case "task:settle": {
      if (msg.task_id !== TASK_ID) return;
      settleAction = msg.action;
      log("Req", `received task:settle  action=${msg.action}`);
      signal("settled");
      break;
    }
  }
});

// ── Kick off ──────────────────────────────────────────────────────────────────
swarmReq.broadcast({
  type: "task:announce",
  task_id: TASK_ID,
  prompt: "Say hello in one word.",
  model: "claude-sonnet",
  blob_size: ciphertext.length,
  requester_pubkey: pubReq,
  rsa_public_key: "",
  timestamp: new Date().toISOString(),
});
log("Req", "broadcast task:announce");

// ── Wait for completion ───────────────────────────────────────────────────────
await waitFor("aes_key_received");
log("", "✓ AES key exchange complete");

await waitFor("blob_received");
log("", "✓ Blob transmitted and decrypted");

await waitFor("settled");
log("", "✓ Task settled");

// ── Cleanup ───────────────────────────────────────────────────────────────────
await swarmAcc.destroy();
await swarmReq.destroy();
await testnet.destroy();
rmSync(ROOT, { recursive: true, force: true });

// ── Assert ────────────────────────────────────────────────────────────────────
const ok = settleAction === "approve"
  && logLines.some(l => l.includes("stub agent"))
  ;

console.log("");
if (ok) {
  console.log("PASS — full task flow: announce→claim→match→blob→settle");
  process.exit(0);
} else {
  console.log("FAIL");
  console.log("  settleAction:", settleAction);
  console.log("  logLines:", logLines);
  process.exit(1);
}
