/**
 * Two-process P2P smoke: spawns a "server" child and a "client" child,
 * verifies they discover each other and exchange a task:announce message.
 *
 * Uses @hyperswarm/testnet — the parent creates the local DHT cluster and
 * writes its bootstrap addresses to a tmp file; workers read that file so
 * they all join the same local DHT rather than the real internet DHT.
 *
 * Usage: node --import tsx/esm tests/p2p_two_process.ts
 */

import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import createTestnet from "@hyperswarm/testnet";

const __dir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dir, "..");

// Resolve tsx/esm the same way bin/ash does.
const _req = createRequire(import.meta.url);
const tsxEsmPath = pathToFileURL(_req.resolve("tsx/esm")).href;

// Create a local DHT testnet and share bootstrap addresses via a tmp file.
const testnet = await createTestnet(3);
const bootstrapPath = join(tmpdir(), `ash-bootstrap-${Date.now()}.json`);
writeFileSync(bootstrapPath, JSON.stringify(testnet.bootstrap));

// TypeScript worker: run with `node --import tsx/esm <path> server|client <bootstrapFile>`
const workerTs = `
const role = process.argv[2];           // "server" | "client"
const bootstrapFile = process.argv[3];  // path to JSON bootstrap addresses

const pid = process.pid.toString();
process.env.ASH_DIR = \`${tmpdir()}/ash-2proc-\${role}-\${pid}\`;
process.env.ASH_DB  = ":memory:";

import { readFileSync } from "node:fs";
import { AshSwarm } from "${projectRoot}/core/p2p/swarm.ts";
import { generateEd25519KeyPair, publicKeyToRawHex } from "${projectRoot}/core/crypto/ed25519.ts";

const bootstrap = JSON.parse(readFileSync(bootstrapFile, "utf8"));
const kp = generateEd25519KeyPair();
const pubHex = publicKeyToRawHex(kp.publicKey);
const swarm = new AshSwarm();
await swarm.join(kp.privateKey, pubHex, { bootstrap });

if (role === "server") {
  process.stdout.write("server:ready\\n");

  let got = false;
  swarm.onMessage((_peer, msg) => {
    if (msg.type === "task:announce") {
      process.stdout.write("server:received:" + msg.task_id + "\\n");
      got = true;
    }
  });

  await new Promise(r => setTimeout(r, 25000));
  if (!got) process.stdout.write("server:no-announce\\n");

} else {
  // Wait for peer discovery via DHT.
  let waited = 0;
  while (swarm.getPeers().length === 0 && waited < 20000) {
    await new Promise(r => setTimeout(r, 200));
    waited += 200;
  }
  if (swarm.getPeers().length === 0) {
    process.stdout.write("client:no-peers\\n");
    process.exit(1);
  }
  process.stdout.write("client:peers=" + swarm.getPeers().length + "\\n");

  swarm.broadcast({
    type: "task:announce", task_id: "t1", prompt: "hi", model: "claude-sonnet",
    blob_size: 0, requester_pubkey: pubHex, rsa_public_key: "",
    timestamp: new Date().toISOString(),
  });
  process.stdout.write("client:announced\\n");

  await new Promise(r => setTimeout(r, 3000));
}

await swarm.destroy().catch(() => {});
process.exit(0);
`;

// Use .mts extension so tsx always transpiles as ESM (supports top-level await)
// regardless of whether the temp dir has a package.json with "type":"module".
const workerPath = join(tmpdir(), `ash-worker-${Date.now()}.mts`);
writeFileSync(workerPath, workerTs);

function spawnWorker(role: string): {
  child: ReturnType<typeof spawn>;
  lines: string[];
} {
  const child = spawn(
    process.execPath,
    ["--import", tsxEsmPath, workerPath, role, bootstrapPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines: string[] = [];
  child.stdout.on("data", (d: Buffer) => {
    for (const l of d.toString().split("\n").filter(Boolean)) {
      console.log(`  [${role}] ${l}`);
      lines.push(l);
    }
  });
  child.stderr.on("data", (d: Buffer) => {
    const s = d.toString().trim();
    if (s) console.error(`  [${role}:err] ${s}`);
  });
  return { child, lines };
}

console.log("Starting server…");
const srv = spawnWorker("server");

// Wait for server to be ready before starting client.
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server never became ready")), 15_000);
  const check = setInterval(() => {
    if (srv.lines.some(l => l === "server:ready")) {
      clearInterval(check);
      clearTimeout(t);
      resolve();
    }
  }, 200);
});

console.log("Starting client…");
const cli = spawnWorker("client");

await new Promise<void>((resolve) => {
  cli.child.on("exit", () => resolve());
  setTimeout(resolve, 20_000);
});

await new Promise<void>(r => setTimeout(r, 800));
srv.child.kill("SIGTERM");
await new Promise<void>(r => setTimeout(r, 500));

await testnet.destroy();
try { rmSync(workerPath, { force: true }); } catch { /* ignore */ }
try { rmSync(bootstrapPath, { force: true }); } catch { /* ignore */ }

const serverGot      = srv.lines.some(l => l.startsWith("server:received:"));
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
