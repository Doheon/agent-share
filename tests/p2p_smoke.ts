/**
 * Smoke test: two AshSwarm instances in the same process exchange a message.
 *
 * Uses @hyperswarm/testnet for a local DHT cluster so no real internet or
 * open UDP ports are needed.
 *
 * Usage: node --import tsx/esm tests/p2p_smoke.ts
 *
 * Expected output:
 *   [A] joined
 *   [B] joined
 *   [A] peers=1  broadcasting announce
 *   [B] received: {"type":"task:announce",...}
 *   PASS
 */

process.env.ASH_DB = ":memory:";

import createTestnet from "@hyperswarm/testnet";
import { AshSwarm } from "../core/p2p/swarm.ts";
import {
  generateEd25519KeyPair,
  publicKeyToRawHex,
} from "../core/crypto/ed25519.ts";
import type { P2PMessage } from "../core/p2p/messages.ts";

const TIMEOUT_MS = 30_000;

const kpA = generateEd25519KeyPair();
const pubA = publicKeyToRawHex(kpA.publicKey);
const kpB = generateEd25519KeyPair();
const pubB = publicKeyToRawHex(kpB.publicKey);

const testnet = await createTestnet(3);

const swarmA = new AshSwarm();
const swarmB = new AshSwarm();

await swarmA.join(kpA.privateKey, pubA, { bootstrap: testnet.bootstrap });
console.log("[A] joined");

await swarmB.join(kpB.privateKey, pubB, { bootstrap: testnet.bootstrap });
console.log("[B] joined");

const received = await Promise.race<P2PMessage | "timeout">([
  new Promise<P2PMessage>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("timeout: B never received task:announce")),
      TIMEOUT_MS,
    );
    swarmB.onMessage((_peer, msg) => {
      if (msg.type === "task:announce") {
        clearTimeout(t);
        resolve(msg);
      }
    });
    const poll = setInterval(() => {
      if (swarmA.getPeers().length === 0) return;
      clearInterval(poll);
      console.log(`[A] peers=${swarmA.getPeers().length}  broadcasting announce`);
      swarmA.broadcast({
        type: "task:announce",
        task_id: "smoke-1",
        prompt: "hello",
        model: "claude-sonnet",
        blob_size: 0,
        requester_pubkey: pubA,
        rsa_public_key: "",
        timestamp: new Date().toISOString(),
      });
    }, 300);
  }),
]).catch((err: Error) => {
  console.error("FAIL:", err.message);
  return "timeout" as const;
});

await swarmA.destroy();
await swarmB.destroy();
await testnet.destroy();

if (received === "timeout") {
  process.exit(1);
}

console.log("[B] received:", JSON.stringify(received));
console.log("PASS");
process.exit(0);
