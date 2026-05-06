import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateEd25519KeyPair,
  publicKeyToRawHex,
  signEd25519,
} from "../../core/crypto/ed25519.ts";
import { canonicalStringify } from "../../shared/canonical.ts";
import { eventWithoutSignature, type SignupEvent } from "../../shared/events.ts";
import type { KeyObject } from "node:crypto";

// Shared in-memory core map; populated per-test, cleared in beforeEach.
// vi.hoisted runs before imports so the mock factory can close over it.
const fakeCores = vi.hoisted(() => new Map<string, string[]>());

vi.mock("../../core/ledger/store.ts", () => {
  const fakeStore = {
    get: (keyBuf: Buffer, _opts?: unknown) => {
      const k = keyBuf.toString("hex");
      return {
        ready: async () => {},
        update: async () => {},
        get length() { return fakeCores.get(k)?.length ?? 0; },
        get: async (i: number) => (fakeCores.get(k) ?? [])[i],
      };
    },
    namespace: (_ns: string) => ({
      get: (_opts: { name: string }) => ({
        ready: async () => {},
        update: async () => {},
        get length() { return 0; },
        get: async (_i: number) => undefined,
      }),
    }),
  };
  return {
    getCorestore: async () => fakeStore,
    closeCorestore: async () => {},
  };
});

vi.mock("../../shared/constants.ts", () => ({
  ADMIN_PUBKEY: "0".repeat(64),
  ADMIN_LEDGER_KEY: "",
  LEDGER_TOPIC: Buffer.alloc(32),
}));

import { peerHasSignupEvent } from "./admin.ts";

// 32-byte all-'a' ledger key hex used as the fake peer's core address.
const FAKE_LEDGER_KEY = "a".repeat(64);

function makeSignupEvent(pubHex: string, privKey: KeyObject): SignupEvent {
  const base = {
    type: "signup" as const,
    nonce: 0,
    timestamp: "2024-01-01T00:00:00Z",
    signature: "",
    username: "test",
    ed25519_public_key: pubHex,
    rsa_public_key: "rsa-pub-pem",
  };
  const sig = signEd25519(
    canonicalStringify(eventWithoutSignature(base as SignupEvent)),
    privKey,
  );
  return { ...base, signature: sig };
}

describe("peerHasSignupEvent", () => {
  beforeEach(() => {
    fakeCores.clear();
  });

  it("returns true when the core contains a valid SignupEvent", async () => {
    const { privateKey, publicKey } = generateEd25519KeyPair();
    const pubHex = publicKeyToRawHex(publicKey);
    fakeCores.set(FAKE_LEDGER_KEY, [JSON.stringify(makeSignupEvent(pubHex, privateKey))]);

    expect(await peerHasSignupEvent(pubHex, FAKE_LEDGER_KEY, 0)).toBe(true);
  });

  it("returns false when the core is empty", async () => {
    const { publicKey } = generateEd25519KeyPair();
    const pubHex = publicKeyToRawHex(publicKey);
    fakeCores.set(FAKE_LEDGER_KEY, []);

    expect(await peerHasSignupEvent(pubHex, FAKE_LEDGER_KEY, 0)).toBe(false);
  });

  it("returns false when ed25519_public_key in the event does not match the queried pubkey", async () => {
    const user = generateEd25519KeyPair();
    const other = generateEd25519KeyPair();
    const userPub = publicKeyToRawHex(user.publicKey);
    const otherPub = publicKeyToRawHex(other.publicKey);
    // Core has user's valid SignupEvent, but we query for other's pubkey.
    fakeCores.set(FAKE_LEDGER_KEY, [JSON.stringify(makeSignupEvent(userPub, user.privateKey))]);

    expect(await peerHasSignupEvent(otherPub, FAKE_LEDGER_KEY, 0)).toBe(false);
  });

  it("returns false when the SignupEvent signature is forged (signed by a different key)", async () => {
    const { publicKey } = generateEd25519KeyPair();
    const pubHex = publicKeyToRawHex(publicKey);
    // Attacker signs with their own key but claims the victim's pubkey.
    const attacker = generateEd25519KeyPair();
    const forgedEv = makeSignupEvent(pubHex, attacker.privateKey);
    fakeCores.set(FAKE_LEDGER_KEY, [JSON.stringify(forgedEv)]);

    expect(await peerHasSignupEvent(pubHex, FAKE_LEDGER_KEY, 0)).toBe(false);
  });

  it("returns false for a syntactically invalid pubkey hex", async () => {
    fakeCores.set(FAKE_LEDGER_KEY, []);

    expect(await peerHasSignupEvent("not-hex", FAKE_LEDGER_KEY, 0)).toBe(false);
  });

  it("skips malformed entries and still finds a valid SignupEvent later in the core", async () => {
    const { privateKey, publicKey } = generateEd25519KeyPair();
    const pubHex = publicKeyToRawHex(publicKey);
    fakeCores.set(FAKE_LEDGER_KEY, [
      "not json",
      JSON.stringify({ type: "spend", nonce: 0, amount: 5 }),
      JSON.stringify(makeSignupEvent(pubHex, privateKey)),
    ]);

    expect(await peerHasSignupEvent(pubHex, FAKE_LEDGER_KEY, 0)).toBe(true);
  });
});
