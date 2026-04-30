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

  async join(privKey: KeyObject, pubKeyHex: string): Promise<void> {
    this.privKey = privKey;
    this.pubKeyHex = pubKeyHex;

    // Lazy-import Hyperswarm so that simply importing this module doesn't
    // bind UDP sockets (matters for tests / `--help`).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { default: Hyperswarm } = (await import("hyperswarm")) as any;
    // eslint-disable-next-line new-cap
    this.swarm = new Hyperswarm();

    this.swarm.on("connection", (conn: Conn) => this.handleConnection(conn));

    this.swarm.join(TOPIC, { server: true, client: true });
    // Peers arrive asynchronously via the "connection" event, so we don't
    // block on `swarm.flush()` here — on a fresh / offline box DHT discovery
    // never settles and the old 5s cap was the sole reason `ash` took 5s to
    // render. Callers react to peer arrivals via onConnect.
  }

  private handleConnection(conn: Conn): void {
    const id: string = conn.remotePublicKey.toString("hex");

    // Generate a fresh challenge and send it immediately.
    const myNonceBytes = randomBytes(32);
    const myNonceHex = bytesToHex(myNonceBytes);
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
        console.debug(`[swarm] handshake timeout for ${id.slice(0, 16)} — closing`);
        conn.destroy();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    const completeHandshake = (): void => {
      if (handshakeDone || !verifiedPubkey) return;
      handshakeDone = true;
      clearTimeout(handshakeTimer);

      const peer: SwarmPeer = {
        id,
        pubkey: verifiedPubkey,
        send: (msg: P2PMessage): void => {
          try {
            conn.write(JSON.stringify(msg) + "\n");
          } catch (err) {
            console.debug(`[swarm] write error for peer ${id.slice(0, 16)}:`, (err as Error).message);
          }
        },
      };
      this.peers.set(id, peer);
      for (const h of this.connectHandlers) h(peer);
      // Deliver any application messages that arrived during the handshake.
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
          try {
            const sig = signEd25519(hexToBytes(theirNonceHex), this.privKey!);
            conn.write(JSON.stringify({ type: "peer:hello", pubkey: this.pubKeyHex, sig }) + "\n");
          } catch (err) {
            console.debug(`[swarm] failed to send peer:hello to ${id.slice(0, 16)}:`, (err as Error).message);
            conn.destroy();
          }
          continue;
        }

        // ── Handshake: peer:hello ──────────────────────────────────────────
        if (raw.type === "peer:hello") {
          if (verifiedPubkey) continue; // ignore duplicate hellos
          const theirPubkey = raw.pubkey as string;
          const theirSig = raw.sig as string;
          try {
            const pk = rawHexToPublicKey(theirPubkey);
            if (!verifyEd25519(myNonceBytes, theirSig, pk)) {
              console.debug(`[swarm] peer:hello signature invalid from ${id.slice(0, 16)} — closing`);
              conn.destroy();
              return;
            }
            verifiedPubkey = theirPubkey;
            completeHandshake();
          } catch (err) {
            console.debug(`[swarm] peer:hello verification error from ${id.slice(0, 16)}:`, (err as Error).message);
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
      if (!this.peers.delete(id)) return; // never completed handshake — no disconnect event
      for (const h of this.disconnectHandlers) h(id);
    };
    conn.on("close", cleanup);
    conn.on("error", cleanup);
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  onConnect(handler: ConnectHandler): void {
    this.connectHandlers.push(handler);
  }

  onDisconnect(handler: DisconnectHandler): void {
    this.disconnectHandlers.push(handler);
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
    try { rmSync(this.storage, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
