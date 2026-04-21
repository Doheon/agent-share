import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { AshSwarm } from "./swarm.ts";
import type { P2PMessage } from "./messages.ts";

function makeMockConn(pubKeyHex = "aabbccdd") {
  const conn = new EventEmitter() as any;
  conn.remotePublicKey = Buffer.from(pubKeyHex.padEnd(64, "0"), "hex");
  conn.write = vi.fn();
  conn.destroy = vi.fn();
  return conn;
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

  beforeEach(() => {
    swarm = new AshSwarm();
  });

  it("getPeers() returns empty array before joining", () => {
    expect(swarm.getPeers()).toEqual([]);
  });

  it("onMessage handler receives parsed message when data arrives", async () => {
    const received: P2PMessage[] = [];
    swarm.onMessage((_peer, msg) => received.push(msg));

    const conn = makeMockConn("aabb");
    (swarm as any).handleConnection(conn);

    conn.emit("data", Buffer.from(JSON.stringify(infoMsg) + "\n"));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(infoMsg);
  });

  it("onConnect handler fires when handleConnection is called", () => {
    const connected: string[] = [];
    swarm.onConnect((peer) => connected.push(peer.id));

    const conn = makeMockConn("ccdd");
    (swarm as any).handleConnection(conn);

    expect(connected).toHaveLength(1);
    expect(connected[0]).toBe(conn.remotePublicKey.toString("hex"));
  });

  it("onDisconnect handler fires and peer is removed on close event", () => {
    const disconnected: string[] = [];
    swarm.onDisconnect((id) => disconnected.push(id));

    const conn = makeMockConn("eeff");
    (swarm as any).handleConnection(conn);

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
    (swarm as any).handleConnection(conn);

    const peerId = conn.remotePublicKey.toString("hex");
    expect(swarm.getPeers()).toContain(peerId);

    conn.emit("error", new Error("network error"));

    expect(disconnected).toContain(peerId);
    expect(swarm.getPeers()).not.toContain(peerId);
  });

  it("broadcast calls write on all connected peers", () => {
    const conn1 = makeMockConn("aaaa");
    const conn2 = makeMockConn("bbbb");
    (swarm as any).handleConnection(conn1);
    (swarm as any).handleConnection(conn2);

    swarm.broadcast(infoMsg);

    expect(conn1.write).toHaveBeenCalledWith(JSON.stringify(infoMsg) + "\n");
    expect(conn2.write).toHaveBeenCalledWith(JSON.stringify(infoMsg) + "\n");
  });

  it("malformed JSON line is skipped, subsequent valid message still delivered", () => {
    const received: P2PMessage[] = [];
    swarm.onMessage((_peer, msg) => received.push(msg));

    const conn = makeMockConn("cccc");
    (swarm as any).handleConnection(conn);

    conn.emit("data", Buffer.from("this is not json\n" + JSON.stringify(infoMsg) + "\n"));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(infoMsg);
  });

  it("connection is destroy()ed when buffer exceeds 10MB", () => {
    const conn = makeMockConn("dddd");
    (swarm as any).handleConnection(conn);

    // Send 11MB without any newlines so the buffer grows past MAX_BUF
    const chunk = Buffer.alloc(11 * 1024 * 1024, "x");
    conn.emit("data", chunk);

    expect(conn.destroy).toHaveBeenCalled();
  });

  it("destroy() does not throw when swarm was never joined", async () => {
    await expect(swarm.destroy()).resolves.toBeUndefined();
  });

  it("message split across multiple data chunks is reassembled correctly", () => {
    const received: P2PMessage[] = [];
    swarm.onMessage((_peer, msg) => received.push(msg));

    const conn = makeMockConn("eeee");
    (swarm as any).handleConnection(conn);

    const full = JSON.stringify(infoMsg) + "\n";
    const mid = Math.floor(full.length / 2);

    conn.emit("data", Buffer.from(full.slice(0, mid)));
    expect(received).toHaveLength(0);

    conn.emit("data", Buffer.from(full.slice(mid)));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(infoMsg);
  });
});
