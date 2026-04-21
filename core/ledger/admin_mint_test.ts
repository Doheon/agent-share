import { describe, it, expect, vi } from "vitest";
import { generateEd25519KeyPair, publicKeyToRawHex, signEd25519 } from "../crypto/ed25519.ts";

// Hoisted so the mock factory below can close over the admin identity.
const admin = vi.hoisted(() => {
  const { generateEd25519KeyPair: gen, publicKeyToRawHex: pubHex } = require("../crypto/ed25519.ts") as typeof import("../crypto/ed25519.ts");
  const { privateKey, publicKey } = gen();
  return { priv: privateKey, pubHex: pubHex(publicKey) };
});

vi.mock("./store.ts", () => {
  type FakeCore = {
    entries: string[];
    ready: () => Promise<void>;
    length: number;
    get: (i: number) => Promise<string>;
    append: (data: string) => Promise<void>;
    key: Buffer;
    update: () => Promise<void>;
  };

  const cores = new Map<string, FakeCore>();
  function makeFakeCore(): FakeCore {
    const entries: string[] = [];
    return {
      entries,
      ready: async () => {},
      get length() { return entries.length; },
      async get(i) { return entries[i]; },
      async append(data) { entries.push(data); },
      key: Buffer.alloc(32, 1),
      async update() {},
    };
  }
  const fakeStore = {
    namespace: (_ns: string) => ({
      get: (opts: { name: string }) => {
        if (!cores.has(opts.name)) cores.set(opts.name, makeFakeCore());
        return cores.get(opts.name)!;
      },
    }),
    get: (keyBuf: Buffer) => {
      const k = keyBuf.toString("hex");
      if (!cores.has(k)) cores.set(k, makeFakeCore());
      return cores.get(k)!;
    },
  };
  return {
    getCorestore: async () => fakeStore,
    closeCorestore: async () => {},
  };
});

vi.mock("../../shared/constants.ts", () => ({
  ADMIN_PUBKEY: admin.pubHex,
  // Empty ADMIN_LEDGER_KEY forces the fallback to getUserCore(ADMIN_PUBKEY),
  // i.e. the core is opened by name in the same store the test writes to.
  ADMIN_LEDGER_KEY: "",
  LEDGER_TOPIC: Buffer.alloc(32),
}));

import { appendEvent, getLocalBalance } from "./events.ts";
import { eventWithoutSignature, type MintEvent } from "../../shared/events.ts";
import { canonicalStringify } from "../../shared/canonical.ts";

function signedMint(
  recipient: string,
  amount: number,
  reason: string,
  nonce: number,
): MintEvent {
  const base = {
    type: "mint" as const,
    nonce,
    timestamp: "2024-01-01T00:00:00Z",
    signature: "",
    amount,
    recipient_pubkey: recipient,
    reason,
    signer_pubkey: admin.pubHex,
  };
  const sig = signEd25519(canonicalStringify(eventWithoutSignature(base as MintEvent)), admin.priv);
  return { ...base, signature: sig };
}

function uid(n: number): string {
  return "recv" + n.toString().padStart(60, "0");
}

describe("admin mint replay", () => {
  it("single signup mint credits the recipient", async () => {
    const user = uid(1);
    await appendEvent(admin.pubHex, signedMint(user, 100, "signup", 0));
    expect(await getLocalBalance(user)).toBe(100);
  });

  it("duplicate signup mints for same recipient count only once", async () => {
    const user = uid(2);
    await appendEvent(admin.pubHex, signedMint(user, 100, "signup", 0));
    await appendEvent(admin.pubHex, signedMint(user, 100, "signup", 1));
    await appendEvent(admin.pubHex, signedMint(user, 100, "signup", 2));
    expect(await getLocalBalance(user)).toBe(100);
  });

  it("signup + non-signup mints for same recipient: all non-signup counted, signup capped at one", async () => {
    const user = uid(3);
    await appendEvent(admin.pubHex, signedMint(user, 100, "signup", 0));
    await appendEvent(admin.pubHex, signedMint(user, 25, "bonus", 1));
    await appendEvent(admin.pubHex, signedMint(user, 100, "signup", 2)); // capped
    await appendEvent(admin.pubHex, signedMint(user, 50, "reward", 3));
    expect(await getLocalBalance(user)).toBe(100 + 25 + 50);
  });

  it("signup mints for different recipients are independent", async () => {
    const userA = uid(4);
    const userB = uid(5);
    await appendEvent(admin.pubHex, signedMint(userA, 100, "signup", 0));
    await appendEvent(admin.pubHex, signedMint(userB, 100, "signup", 1));
    expect(await getLocalBalance(userA)).toBe(100);
    expect(await getLocalBalance(userB)).toBe(100);
  });

  it("mint signed by a non-admin key is ignored", async () => {
    const user = uid(6);
    const attacker = generateEd25519KeyPair();
    const attackerHex = publicKeyToRawHex(attacker.publicKey);
    const base = {
      type: "mint" as const,
      nonce: 0,
      timestamp: "2024-01-01T00:00:00Z",
      signature: "",
      amount: 999,
      recipient_pubkey: user,
      reason: "signup",
      signer_pubkey: attackerHex, // NOT the admin pubkey used by replay
    };
    const sig = signEd25519(canonicalStringify(eventWithoutSignature(base as MintEvent)), attacker.privateKey);
    await appendEvent(admin.pubHex, { ...base, signature: sig });
    expect(await getLocalBalance(user)).toBe(0);
  });
});
