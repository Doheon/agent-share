/**
 * Two-process P2P smoke: spawns a "server" child and a "client" child,
 * verifies they discover each other and exchange a task:announce message.
 *
 * Usage: node tests/p2p_two_process.mjs
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";

const TOPIC_HEX = createHash("sha256").update("ash-network-v1").digest("hex");

// Worker script written to a temp file so we can spawn it as a separate process.
const workerScript = `
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

const TOPIC = Buffer.from("${TOPIC_HEX}", "hex");
const role = process.argv[2]; // "server" or "client"
const storage = tmpdir() + "/ash-2proc-" + role + "-" + process.pid;

const { default: Hyperswarm } = await import("hyperswarm");
const swarm = new Hyperswarm({ storage });
const peers = new Map();
const handlers = [];

swarm.on("connection", (conn) => {
  const id = conn.remotePublicKey.toString("hex");
  const send = (msg) => { try { conn.write(JSON.stringify(msg) + "\\n"); } catch {} };
  peers.set(id, { id, send });

  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    const lines = buf.split("\\n");
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
process.stdout.write(role + ":joined\\n");

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
    process.stdout.write("client:no-peers\\n");
    process.exit(1);
  }
  process.stdout.write("client:peers=" + getPeers().length + "\\n");
  broadcast({ type: "task:announce", task_id: "t1", prompt: "hi", model: "claude-sonnet",
    blob_size: 0, requester_pubkey: "client-pub", rsa_public_key: "", timestamp: new Date().toISOString() });
  process.stdout.write("client:announced\\n");
  await new Promise(r => setTimeout(r, 3000));
} else {
  // Server: wait for announce
  let got = false;
  onMessage((peer, msg) => {
    if (msg.type === "task:announce") {
      process.stdout.write("server:received:" + msg.task_id + "\\n");
      got = true;
    }
  });
  await new Promise(r => setTimeout(r, 20000));
  if (!got) process.stdout.write("server:no-announce\\n");
}

try { await swarm.destroy(); } catch {}
try { rmSync(storage, { recursive: true, force: true }); } catch {}
process.exit(0);
`;

const workerPath = new URL(`./p2p_worker_${Date.now()}.mjs`, import.meta.url).pathname;
writeFileSync(workerPath, workerScript);

function spawnWorker(role) {
  const cwd = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const child = spawn("node", [workerPath, role], { stdio: ["ignore", "pipe", "pipe"], cwd });
  const lines = [];
  child.stdout.on("data", (d) => {
    for (const l of d.toString().split("\n").filter(Boolean)) {
      console.log(`  [${role}] ${l}`);
      lines.push(l);
    }
  });
  child.stderr.on("data", (d) => {
    if (d.toString().trim()) console.error(`  [${role}:err] ${d.toString().trim()}`);
  });
  return { child, lines };
}

console.log("Starting server...");
const srv = spawnWorker("server");

await new Promise(r => setTimeout(r, 3000));

console.log("Starting client (3s after server)...");
const cli = spawnWorker("client");

await new Promise((resolve) => {
  cli.child.on("exit", resolve);
  setTimeout(resolve, 25000);
});

// Give server a moment to print
await new Promise(r => setTimeout(r, 500));
srv.child.kill("SIGTERM");
await new Promise(r => setTimeout(r, 500));

try { import("node:fs").then(m => m.rmSync(workerPath, { force: true })); } catch {}
const serverGot = srv.lines.some(l => l.startsWith("server:received:"));
const clientAnnounced = cli.lines.some(l => l === "client:announced");

console.log("");
if (clientAnnounced && serverGot) {
  console.log("PASS — client announced, server received");
  process.exit(0);
} else {
  console.log("FAIL");
  console.log("  client announced:", clientAnnounced);
  console.log("  server received: ", serverGot);
  process.exit(1);
}
