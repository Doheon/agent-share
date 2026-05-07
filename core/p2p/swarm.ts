/**
 * Hyperswarm wrapper that hides the raw socket protocol.
 *
 * All ash peers join the same fixed topic so that any two clients on the
 * network can discover each other without a tracker. Messages are JSON
 * payloads delimited by newlines.
 *
 * Every connection goes through a challenge/response handshake that binds
 * the peer's declared Ed25519 identity to the Noise transport key before any
 * application messages are delivered.  Peers that fail or skip the handshake
 * are destroyed.
 */

import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import type { P2PMessage } from "./messages.ts";
import { isValidMessage } from "./messages.ts";
import { PROTOCOL_VERSION } from "../../shared/protocol.ts";
import {
  signEd25519,
  verifyEd25519,
  rawHexToPublicKey,
  bytesToHex,
  hexToBytes,
} from "../crypto/ed25519.ts";

const TOPIC = createHash("sha256").update("ash-network-v1").digest();
const MAX_BUF = 10 * 1024 * 1024; // 10 MB — guard against unbounded memory growth
const HANDSHAKE_TIMEOUT_MS = 10_000;

// Verbose handshake/disconnect chatter is opt-in via ASH_DEBUG_SWARM=1.
// Production users were getting stderr spam on every transient peer drop;
// the messages stay valuable for development but should not pollute
// normal CLI output.
const DEBUG = process.env.ASH_DEBUG_SWARM === "1";
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.debug(...args);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Conn = any;

export interface SwarmPeer {
  /** Noise transport key (hex) — connection identifier, NOT the application identity. */
  id: string;
  /** Ed25519 identity key (hex), verified via challenge/response at connection time. */
  pubkey: string;
  send: (msg: P2PMessage) => void;
}

export type MessageHandler = (peer: SwarmPeer, msg: P2PMessage) => void;
export type ConnectHandler = (peer: SwarmPeer) => void;
export type DisconnectHandler = (peerId: string) => void;

export class AshSwarm {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private swarm: any = null;
  private peers = new Map<string, SwarmPeer>();
  private handlers: MessageHandler[] = [];
  private connectHandlers: ConnectHandler[] = [];
  private disconnectHandlers: DisconnectHandler[] = [];
  private readonly storage = `${tmpdir()}/ash-swarm-${process.pid}`;
  private privKey: KeyObject | null = null;
  private pubKeyHex: string = "";
  // id → Map<connKey(Symbol), sendFn> — tracks simultaneous duplicate connections
  private activeSends = new Map<string, Map<symbol, (msg: P2PMessage) => void>>();

  async join(
    privKey: KeyObject,
    pubKeyHex: string,
    opts?: { bootstrap?: Array<{ host: string; port: number }> },
  ): Promise<void> {
    this.privKey = privKey;
    this.pubKeyHex = pubKeyHex;

    // Lazy-import Hyperswarm so that simply importing this module doesn't
    // bind UDP sockets (matters for tests / `--help`).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { default: Hyperswarm } = (await import("hyperswarm")) as any;
    // eslint-disable-next-line new-cap
    this.swarm = new Hyperswarm(opts?.bootstrap ? { bootstrap: opts.bootstrap } : {});

    this.swarm.on("connection", (conn: Conn) => this.handleConnection(conn));

    this.swarm.join(TOPIC, { server: true, client: true });
    // In production, we skip flush() — on a cold/offline box the DHT query
    // never settles and the old 5s cap was the only reason `ash` felt slow.
    // In testnet mode (bootstrap provided), flush() completes quickly and
    // ensures the node is announced before join() returns, so a second swarm
    // joining afterwards can immediately discover this one via DHT lookup.
    if (opts?.bootstrap) {
      await this.swarm.flush().catch(() => undefined);
    }
  }

  private handleConnection(conn: Conn): void {
    const connKey = Symbol();
    const id: string = conn.remotePublicKey.toString("hex");

    // Channel binding: include the local + remote Noise transport keys in
    // the signed payload. A relay/MITM that proxies two Noise sessions
    // would have different remote keys on each side, so a signature valid
    // for one side does not validate on the other. Without this binding,
    // a compromised relay holding two sessions could forward V's
    // challenge to A and A's hello back to V — defeating the handshake's
    // identity attestation.
    //
    // `@hyperswarm/secret-stream` exposes both `publicKey` and
    // `remotePublicKey` once the Noise handshake completes, which is
    // before our `connection` event fires. If for some reason the local
    // key is missing we refuse the connection rather than silently
    // degrading the binding to nonce-only.
    // We rely on `conn.publicKey` and `conn.remotePublicKey` from
    // `@hyperswarm/secret-stream`. If the upstream library ever renames or
    // changes the type of these fields, the channel-binding payload below
    // would silently degrade (string "undefined", or local === remote)
    // and a relay/MITM could replay one session into another. Refuse to
    // proceed unless both keys are 32-byte buffers and distinct.
    if (
      !Buffer.isBuffer(conn.publicKey) ||
      !Buffer.isBuffer(conn.remotePublicKey) ||
      conn.publicKey.length !== 32 ||
      conn.remotePublicKey.length !== 32 ||
      conn.publicKey.equals(conn.remotePublicKey)
    ) {
      console.error(`[swarm] invalid Noise transport keys on connection — closing`);
      try { conn.destroy(); } catch { /* ignore */ }
      return;
    }
    const localTransportHex = (conn.publicKey as Buffer).toString("hex");
    const remoteTransportHex = id;

    // Generate a fresh challenge and send it immediately.
    const myNonceBytes = randomBytes(32);
    const myNonceHex = bytesToHex(myNonceBytes);
    const challengePayload = `${myNonceHex}|${localTransportHex}|${remoteTransportHex}`;
    try {
      conn.write(JSON.stringify({ type: "peer:challenge", nonce: myNonceHex }) + "\n");
    } catch {
      return;
    }

    // Per-connection handshake state.
    let verifiedPubkey: string | null = null;
    let sentHello = false;
    let handshakeDone = false;
    const buffered: P2PMessage[] = [];

    // Destroy the connection if the handshake doesn't complete in time.
    const handshakeTimer = setTimeout(() => {
      if (!handshakeDone) {
        debugLog(`[swarm] handshake timeout for ${id.slice(0, 16)} — closing`);
        conn.destroy();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    const completeHandshake = (): void => {
      if (handshakeDone || !verifiedPubkey) return;
      handshakeDone = true;
      clearTimeout(handshakeTimer);

      // Serialize writes: if conn.write() returns false (TCP buffer full /
      // backpressure), queue subsequent messages and drain before sending.
      // Writes are synchronous when the queue is empty so test assertions work.
      let backpressured = false;
      const writeQueue: string[] = [];
      const flushWriteQueue = (): void => {
        while (writeQueue.length > 0) {
          const line = writeQueue[0];
          let flushed: boolean;
          try {
            flushed = conn.write(line);
          } catch (err) {
            debugLog(`[swarm] write error for peer ${id.slice(0, 16)}:`, (err as Error).message);
            writeQueue.shift();
            continue;
          }
          writeQueue.shift();
          if (!flushed) {
            backpressured = true;
            conn.once("drain", () => {
              backpressured = false;
              flushWriteQueue();
            });
            break;
          }
        }
      };
      const sendFn = (msg: P2PMessage): void => {
        const line = JSON.stringify(msg) + "\n";
        if (backpressured) {
          writeQueue.push(line);
          return;
        }
        let flushed: boolean;
        try {
          flushed = conn.write(line);
        } catch (err) {
          debugLog(`[swarm] write error for peer ${id.slice(0, 16)}:`, (err as Error).message);
          return;
        }
        if (!flushed) {
          backpressured = true;
          conn.once("drain", () => {
            backpressured = false;
            flushWriteQueue();
          });
        }
      };

      // Register this connection in activeSends; if a peer entry already
      // exists (duplicate simultaneous connection) update its send pointer
      // rather than firing onConnect again.
      let connMap = this.activeSends.get(id);
      if (!connMap) {
        connMap = new Map();
        this.activeSends.set(id, connMap);
      }
      connMap.set(connKey, sendFn);

      const existingPeer = this.peers.get(id);
      if (existingPeer) {
        existingPeer.send = sendFn;
      } else {
        const peer: SwarmPeer = { id, pubkey: verifiedPubkey, send: sendFn };
        this.peers.set(id, peer);
        for (const h of this.connectHandlers) h(peer);
      }
      // Deliver any application messages that arrived during the handshake.
      const peer = this.peers.get(id)!;
      for (const msg of buffered) {
        for (const h of this.handlers) h(peer, msg);
      }
    };

    let buf = "";
    conn.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      if (buf.length > MAX_BUF) {
        console.error(`[swarm] peer ${id.slice(0, 16)} exceeded buffer limit — closing connection`);
        conn.destroy();
        return;
      }
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let raw: any;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }

        // ── Handshake: peer:challenge ──────────────────────────────────────
        if (raw.type === "peer:challenge") {
          if (sentHello) continue; // ignore duplicate challenges
          sentHello = true;
          const theirNonceHex = raw.nonce as string;
          // Sign nonce || theirTransportKey || ourTransportKey. From this
          // side: theirTransportKey === remoteTransportHex (the peer that
          // sent us the challenge), ourTransportKey === localTransportHex.
          // The verifier's perspective inverts the two — see peer:hello
          // verification below for the symmetric reconstruction.
          const replyPayload = `${theirNonceHex}|${remoteTransportHex}|${localTransportHex}`;
          try {
            const sig = signEd25519(replyPayload, this.privKey!);
            conn.write(
              JSON.stringify({
                type: "peer:hello",
                pubkey: this.pubKeyHex,
                sig,
                protocol_version: PROTOCOL_VERSION,
              }) + "\n",
            );
          } catch (err) {
            debugLog(`[swarm] failed to send peer:hello to ${id.slice(0, 16)}:`, (err as Error).message);
            conn.destroy();
          }
          continue;
        }

        // ── Handshake: peer:hello ──────────────────────────────────────────
        if (raw.type === "peer:hello") {
          if (verifiedPubkey) continue; // ignore duplicate hellos
          // Wire-protocol gate: refuse peers whose protocol version does
          // not match ours. Older clients without the field default to 0
          // and are likewise refused — there is no compatibility window
          // back to pre-versioned builds.
          const theirProto = typeof raw.protocol_version === "number" ? raw.protocol_version : 0;
          if (theirProto !== PROTOCOL_VERSION) {
            debugLog(`[swarm] protocol mismatch from ${id.slice(0, 16)}: peer=${theirProto} ours=${PROTOCOL_VERSION} — closing`);
            conn.destroy();
            return;
          }
          const theirPubkey = raw.pubkey as string;
          const theirSig = raw.sig as string;
          try {
            const pk = rawHexToPublicKey(theirPubkey);
            if (!verifyEd25519(challengePayload, theirSig, pk)) {
              debugLog(`[swarm] peer:hello signature invalid from ${id.slice(0, 16)} — closing`);
              conn.destroy();
              return;
            }
            verifiedPubkey = theirPubkey;
            completeHandshake();
          } catch (err) {
            debugLog(`[swarm] peer:hello verification error from ${id.slice(0, 16)}:`, (err as Error).message);
            conn.destroy();
          }
          continue;
        }

        // ── Application message ────────────────────────────────────────────
        // Validate before buffering or dispatching so adversarial peers cannot
        // poison handler state with malformed task_id, oversized blobs, etc.
        if (!isValidMessage(raw)) continue;

        if (!handshakeDone) {
          // Buffer messages that arrive before handshake completes.
          buffered.push(raw as P2PMessage);
          continue;
        }

        const peer = this.peers.get(id);
        if (!peer) continue;
        for (const h of this.handlers) h(peer, raw as P2PMessage);
      }
    });

    const cleanup = (): void => {
      clearTimeout(handshakeTimer);
      const connMap = this.activeSends.get(id);
      if (connMap) {
        connMap.delete(connKey);
        if (connMap.size === 0) {
          this.activeSends.delete(id);
          if (this.peers.delete(id)) {
            for (const h of this.disconnectHandlers) h(id);
          }
        } else {
          // Fall back to whichever connection is still alive.
          const current = this.peers.get(id);
          if (current) current.send = [...connMap.values()].at(-1)!;
        }
      } else if (this.peers.delete(id)) {
        // Handshake completed but activeSends entry missing — still fire disconnect.
        for (const h of this.disconnectHandlers) h(id);
      }
    };
    conn.on("close", cleanup);
    conn.on("error", cleanup);
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  onConnect(handler: ConnectHandler): () => void {
    this.connectHandlers.push(handler);
    return () => {
      const idx = this.connectHandlers.indexOf(handler);
      if (idx >= 0) this.connectHandlers.splice(idx, 1);
    };
  }

  onDisconnect(handler: DisconnectHandler): () => void {
    this.disconnectHandlers.push(handler);
    return () => {
      const idx = this.disconnectHandlers.indexOf(handler);
      if (idx >= 0) this.disconnectHandlers.splice(idx, 1);
    };
  }

  broadcast(msg: P2PMessage): void {
    for (const peer of this.peers.values()) peer.send(msg);
  }

  getPeers(): string[] {
    return [...this.peers.keys()];
  }

  /** Exposes the underlying Hyperswarm instance for corestore replication hooks. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get rawSwarm(): any {
    return this.swarm;
  }

  async destroy(): Promise<void> {
    if (!this.swarm) return;
    try {
      await this.swarm.destroy();
    } catch {
      /* ignore */
    }
    this.swarm = null;
    this.peers.clear();
    this.activeSends.clear();
    try { rmSync(this.storage, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
