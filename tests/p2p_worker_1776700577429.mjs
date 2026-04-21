
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

const TOPIC = Buffer.from("7db43f14906aa1637db6658505cc7e5faacd42d44f950c0356399f4323195bba", "hex");
const role = process.argv[2]; // "server" or "client"
const storage = tmpdir() + "/ash-2proc-" + role + "-" + process.pid;

const { default: Hyperswarm } = await import("hyperswarm");
const swarm = new Hyperswarm({ storage });
const peers = new Map();
const handlers = [];

swarm.on("connection", (conn) => {
  const id = conn.remotePublicKey.toString("hex");
  const send = (msg) => { try { conn.write(JSON.stringify(msg) + "\n"); } catch {} };
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
await Promise.race([swarm.flush(), new Promise(r => setTimeout(r, 5000))]);
process.stdout.write(role + ":joined\n");

const getPeers = () => [...peers.keys()];
const broadcast = (msg) => { for (const p of peers.values()) p.send(msg); };
const onMessage = (h) => handlers.push(h);

if (role === "client") {
  // Wait for peer then broadcast
  let waited = 0;
  while (getPeers().length === 0 && waited < 12000) {
    await new Promise(r => setTimeout(r, 300));
    waited += 300;
  }
  if (getPeers().length === 0) {
    process.stdout.write("client:no-peers\n");
    process.exit(1);
  }
  process.stdout.write("client:peers=" + getPeers().length + "\n");
  broadcast({ type: "task:announce", task_id: "t1", prompt: "hi", model: "claude-sonnet",
    blob_size: 0, requester_pubkey: "client-pub", rsa_public_key: "", timestamp: new Date().toISOString() });
  process.stdout.write("client:announced\n");
  await new Promise(r => setTimeout(r, 3000));
} else {
  // Server: wait for announce
  let got = false;
  onMessage((peer, msg) => {
    if (msg.type === "task:announce") {
      process.stdout.write("server:received:" + msg.task_id + "\n");
      got = true;
    }
  });
  await new Promise(r => setTimeout(r, 20000));
  if (!got) process.stdout.write("server:no-announce\n");
}

try { await swarm.destroy(); } catch {}
try { rmSync(storage, { recursive: true, force: true }); } catch {}
process.exit(0);
