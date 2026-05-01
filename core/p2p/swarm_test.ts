import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { AshSwarm } from "./swarm.ts";
import type { P2PMessage } from "./messages.ts";
import {
  generateEd25519KeyPair,
  publicKeyToRawHex,
  signEd25519,
  hexToBytes,
} from "../crypto/ed25519.ts";
import { PROTOCOL_VERSION } from "../../shared/protocol.ts";
import type { KeyObject } from "node:crypto";

// Spin up an AshSwarm with a real Ed25519 identity but without joining DHT.
// Tests inject mock connections via the private handleConnection API.
function makeSwarmWithIdentity(): { swarm: AshSwarm; priv: KeyObject; pubHex: string } {
  const { privateKey, publicKey } = generateEd25519KeyPair();
  const pubHex = publicKeyToRawHex(publicKey);
  const swarm = new AshSwarm();
  // Bypass `join()` (which would bind UDP sockets); set the handshake
  // identity fields directly.
  (swarm as unknown as { privKey: KeyObject; pubKeyHex: string }).privKey = privateKey;
  (swarm as unknown as { privKey: KeyObject; pubKeyHex: string }).pubKeyHex = pubHex;
  return { swarm, priv: privateKey, pubHex };
}

function makeMockConn(remoteTransportHex = "aabbccdd", localTransportHex = "11223344") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conn = new EventEmitter() as any;
  conn.remotePublicKey = Buffer.from(remoteTransportHex.padEnd(64, "0"), "hex");
  conn.publicKey = Buffer.from(localTransportHex.padEnd(64, "0"), "hex");
  conn.write = vi.fn();
  conn.destroy = vi.fn();
  return conn;
}

// Drives the handshake from the *remote* peer's side. After this returns,
// the remote peer is registered in swarm.peers and onConnect handlers fire.
function completeHandshake(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conn: any,
  remotePriv: KeyObject,
  remotePubHex: string,
): void {
  // The swarm wrote a peer:challenge first — extract its nonce from the
  // first conn.write call.
  const challengeJson = (conn.write.mock.calls[0]?.[0] as string) ?? "";
  const challenge = JSON.parse(challengeJson.trim());
  if (challenge.type !== "peer:challenge") {
    throw new Error(`expected peer:challenge first, got ${challenge.type}`);
  }
  // Channel-bound payload: nonce | swarm_local_transport | swarm_remote_transport.
  // From the simulated remote peer's perspective these two transport keys are
  // swapped, but the bytes signed must match what the swarm reconstructs as
  // its own challengePayload during peer:hello verification.
  const localTransportHex = conn.publicKey.toString("hex");
  const remoteTransportHex = conn.remotePublicKey.toString("hex");
  const payload = `${challenge.nonce}|${localTransportHex}|${remoteTransportHex}`;
  const sig = signEd25519(payload, remotePriv);
  const hello = JSON.stringify({
    type: "peer:hello",
    pubkey: remotePubHex,
    sig,
    protocol_version: PROTOCOL_VERSION,
  }) + "\n";
  conn.emit("data", Buffer.from(hello));
}

const infoMsg: P2PMessage = {
  type: "peer:info",
  pubkey: "aa",
  username: "alice",
  model_tier: "free",
  ledger_core_key: "aa",
};

describe("AshSwarm (no DHT)", () => {
  let swarm: AshSwarm;
  let remotePriv: KeyObject;
  let remotePubHex: string;

  beforeEach(() => {
    ({ swarm } = makeSwarmWithIdentity());
    const remote = generateEd25519KeyPair();
    remotePriv = remote.privateKey;
    remotePubHex = publicKeyToRawHex(remote.publicKey);
  });

  it("getPeers() returns empty array before joining", () => {
    expect(swarm.getPeers()).toEqual([]);
  });

  it("onMessage handler receives parsed message after handshake", () => {
    const received: P2PMessage[] = [];
    swarm.onMessage((_peer, msg) => received.push(msg));

    const conn = makeMockConn("aabb");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn);
    completeHandshake(conn, remotePriv, remotePubHex);

    conn.emit("data", Buffer.from(JSON.stringify(infoMsg) + "\n"));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(infoMsg);
  });

  it("onConnect handler fires after successful handshake", () => {
    const connected: string[] = [];
    swarm.onConnect((peer) => connected.push(peer.id));

    const conn = makeMockConn("ccdd");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn);
    completeHandshake(conn, remotePriv, remotePubHex);

    expect(connected).toHaveLength(1);
    expect(connected[0]).toBe(conn.remotePublicKey.toString("hex"));
  });

  it("onConnect does NOT fire if handshake never completes", () => {
    const connected: string[] = [];
    swarm.onConnect((peer) => connected.push(peer.id));

    const conn = makeMockConn("11ff");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn);
    // No completeHandshake() — peer:hello is never sent.

    expect(connected).toHaveLength(0);
    expect(swarm.getPeers()).not.toContain(conn.remotePublicKey.toString("hex"));
  });

  it("invalid peer:hello signature destroys the connection", () => {
    const conn = makeMockConn("9999");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn);

    // Send a peer:hello with a bogus signature (signed with the wrong key).
    const wrong = generateEd25519KeyPair();
    const challengeJson = (conn.write.mock.calls[0]?.[0] as string) ?? "";
    const challenge = JSON.parse(challengeJson.trim());
    const localTransportHex = conn.publicKey.toString("hex");
    const remoteTransportHex = conn.remotePublicKey.toString("hex");
    const payload = `${challenge.nonce}|${localTransportHex}|${remoteTransportHex}`;
    const badSig = signEd25519(payload, wrong.privateKey);
    const hello = JSON.stringify({
      type: "peer:hello",
      pubkey: remotePubHex,
      sig: badSig,
      protocol_version: PROTOCOL_VERSION,
    }) + "\n";
    conn.emit("data", Buffer.from(hello));

    expect(conn.destroy).toHaveBeenCalled();
    expect(swarm.getPeers()).not.toContain(conn.remotePublicKey.toString("hex"));
  });

  it("peer:hello signed with WRONG channel binding (nonce only) is rejected", () => {
    // Channel-binding regression test: a signature over just the nonce
    // (the old protocol) must NOT verify under the new protocol.
    const conn = makeMockConn("8888");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn);

    const challengeJson = (conn.write.mock.calls[0]?.[0] as string) ?? "";
    const challenge = JSON.parse(challengeJson.trim());
    // Sign just the raw nonce (the pre-channel-binding format).
    const oldSig = signEd25519(hexToBytes(challenge.nonce), remotePriv);
    const hello = JSON.stringify({
      type: "peer:hello",
      pubkey: remotePubHex,
      sig: oldSig,
      protocol_version: PROTOCOL_VERSION,
    }) + "\n";
    conn.emit("data", Buffer.from(hello));

    expect(conn.destroy).toHaveBeenCalled();
    expect(swarm.getPeers()).not.toContain(conn.remotePublicKey.toString("hex"));
  });

  it("onDisconnect handler fires and peer is removed on close event", () => {
    const disconnected: string[] = [];
    swarm.onDisconnect((id) => disconnected.push(id));

    const conn = makeMockConn("eeff");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn);
    completeHandshake(conn, remotePriv, remotePubHex);

    const peerId = conn.remotePublicKey.toString("hex");
    expect(swarm.getPeers()).toContain(peerId);

    conn.emit("close");

    expect(disconnected).toContain(peerId);
    expect(swarm.getPeers()).not.toContain(peerId);
  });

  it("peer is removed on error event", () => {
    const disconnected: string[] = [];
    swarm.onDisconnect((id) => disconnected.push(id));

    const conn = makeMockConn("1122");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn);
    completeHandshake(conn, remotePriv, remotePubHex);

    const peerId = conn.remotePublicKey.toString("hex");
    expect(swarm.getPeers()).toContain(peerId);

    conn.emit("error", new Error("network error"));

    expect(disconnected).toContain(peerId);
    expect(swarm.getPeers()).not.toContain(peerId);
  });

  it("broadcast calls write on all handshake-completed peers", () => {
    const conn1 = makeMockConn("aaaa");
    const conn2 = makeMockConn("bbbb");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn2);

    // Each connection needs its own remote identity for the handshake.
    const remote1 = generateEd25519KeyPair();
    const remote2 = generateEd25519KeyPair();
    completeHandshake(conn1, remote1.privateKey, publicKeyToRawHex(remote1.publicKey));
    completeHandshake(conn2, remote2.privateKey, publicKeyToRawHex(remote2.publicKey));

    swarm.broadcast(infoMsg);

    expect(conn1.write).toHaveBeenCalledWith(JSON.stringify(infoMsg) + "\n");
    expect(conn2.write).toHaveBeenCalledWith(JSON.stringify(infoMsg) + "\n");
  });

  it("malformed JSON line is skipped, subsequent valid message still delivered", () => {
    const received: P2PMessage[] = [];
    swarm.onMessage((_peer, msg) => received.push(msg));

    const conn = makeMockConn("cccc");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn);
    completeHandshake(conn, remotePriv, remotePubHex);

    conn.emit("data", Buffer.from("this is not json\n" + JSON.stringify(infoMsg) + "\n"));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(infoMsg);
  });

  it("connection is destroy()ed when buffer exceeds 10MB", () => {
    const conn = makeMockConn("dddd");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn);

    // Send 11MB without any newlines so the buffer grows past MAX_BUF.
    const chunk = Buffer.alloc(11 * 1024 * 1024, "x");
    conn.emit("data", chunk);

    expect(conn.destroy).toHaveBeenCalled();
  });

  it("destroy() does not throw when swarm was never joined", async () => {
    await expect(swarm.destroy()).resolves.toBeUndefined();
  });

  it("peer:hello with mismatched protocol_version is rejected", () => {
    const conn = makeMockConn("7777");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn);

    const challengeJson = (conn.write.mock.calls[0]?.[0] as string) ?? "";
    const challenge = JSON.parse(challengeJson.trim());
    const localTransportHex = conn.publicKey.toString("hex");
    const remoteTransportHex = conn.remotePublicKey.toString("hex");
    const payload = `${challenge.nonce}|${localTransportHex}|${remoteTransportHex}`;
    const sig = signEd25519(payload, remotePriv);
    const hello = JSON.stringify({
      type: "peer:hello",
      pubkey: remotePubHex,
      sig,
      protocol_version: PROTOCOL_VERSION + 1, // future version we cannot speak
    }) + "\n";
    conn.emit("data", Buffer.from(hello));

    expect(conn.destroy).toHaveBeenCalled();
    expect(swarm.getPeers()).not.toContain(conn.remotePublicKey.toString("hex"));
  });

  it("peer:hello with NO protocol_version (legacy peer) is rejected", () => {
    const conn = makeMockConn("6666");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn);

    const challengeJson = (conn.write.mock.calls[0]?.[0] as string) ?? "";
    const challenge = JSON.parse(challengeJson.trim());
    const localTransportHex = conn.publicKey.toString("hex");
    const remoteTransportHex = conn.remotePublicKey.toString("hex");
    const payload = `${challenge.nonce}|${localTransportHex}|${remoteTransportHex}`;
    const sig = signEd25519(payload, remotePriv);
    const hello = JSON.stringify({ type: "peer:hello", pubkey: remotePubHex, sig }) + "\n";
    conn.emit("data", Buffer.from(hello));

    expect(conn.destroy).toHaveBeenCalled();
  });

  it("message split across multiple data chunks is reassembled correctly", () => {
    const received: P2PMessage[] = [];
    swarm.onMessage((_peer, msg) => received.push(msg));

    const conn = makeMockConn("eeee");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (swarm as any).handleConnection(conn);
    completeHandshake(conn, remotePriv, remotePubHex);

    const full = JSON.stringify(infoMsg) + "\n";
    const mid = Math.floor(full.length / 2);

    conn.emit("data", Buffer.from(full.slice(0, mid)));
    expect(received).toHaveLength(0);

    conn.emit("data", Buffer.from(full.slice(mid)));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(infoMsg);
  });
});
