/**
 * Smoke test: two AshSwarm instances on the same machine exchange a message.
 *
 * Expected output:
 *   [A] joined
 *   [B] joined
 *   [B] received: {"type":"task:announce",...}
 *   PASS
 */

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const TOPIC = createHash("sha256").update("ash-network-v1").digest();

async function makeSwarm(label) {
  const { default: Hyperswarm } = await import("hyperswarm");
  const storage = `${tmpdir()}/ash-smoke-${label}-${process.pid}`;
  const swarm = new Hyperswarm({ storage });
  const peers = new Map();
  const handlers = [];

  swarm.on("connection", (conn) => {
    const id = conn.remotePublicKey.toString("hex");
    const send = (msg) => {
      try { conn.write(JSON.stringify(msg) + "\n"); } catch {}
    };
    peers.set(id, { id, send });

    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          for (const h of handlers) h({ id, send }, msg);
        } catch {}
      }
    });
    conn.on("close", () => peers.delete(id));
    conn.on("error", () => peers.delete(id));
  });

  swarm.join(TOPIC, { server: true, client: true });
  await Promise.race([
    swarm.flush(),
    new Promise((r) => setTimeout(r, 5000)),
  ]);

  return {
    label,
    onMessage: (h) => handlers.push(h),
    broadcast: (msg) => { for (const p of peers.values()) p.send(msg); },
    getPeers: () => [...peers.keys()],
    destroy: async () => {
      try { await swarm.destroy(); } catch {}
    },
  };
}

const TIMEOUT_MS = 20_000;

async function main() {
  const swarmA = await makeSwarm("A");
  console.log("[A] joined");
  const swarmB = await makeSwarm("B");
  console.log("[B] joined");

  const received = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout: B never received message from A")), TIMEOUT_MS);

    swarmB.onMessage((peer, msg) => {
      if (msg.type === "task:announce") {
        clearTimeout(timer);
        resolve(msg);
      }
    });

    // Poll until B sees A as a peer, then broadcast.
    const poll = setInterval(async () => {
      if (swarmA.getPeers().length === 0 && swarmB.getPeers().length === 0) return;
      clearInterval(poll);
      const announce = {
        type: "task:announce",
        task_id: "test-123",
        prompt: "hello",
        model: "claude-sonnet",
        blob_size: 0,
        requester_pubkey: "pub-A",
        rsa_public_key: "",
        timestamp: new Date().toISOString(),
      };
      console.log(`[A] peers=${swarmA.getPeers().length} broadcasting announce`);
      swarmA.broadcast(announce);
    }, 500);
  });

  console.log("[B] received:", JSON.stringify(received));
  await swarmA.destroy();
  await swarmB.destroy();
  console.log("PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
