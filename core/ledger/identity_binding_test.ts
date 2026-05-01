/**
 * Tests for the admin-mint identity binding in verifyEarnCrossRef.
 *
 * The trivial-forgery defense: when ADMIN_PUBKEY is configured, an
 * EarnEvent's counterparty must have at least one valid admin MintEvent.
 * Without it, an attacker who fabricates a throwaway keypair and signs
 * spends in a self-controlled core cannot credit themselves arbitrary earns.
 */

import { describe, it, expect, vi } from "vitest";
import type { KeyObject } from "node:crypto";
import {
  generateEd25519KeyPair,
  publicKeyToRawHex,
  signEd25519,
} from "../crypto/ed25519.ts";
import { canonicalStringify } from "../../shared/canonical.ts";
import { eventWithoutSignature, type Event } from "../../shared/events.ts";

// Configure a real admin pubkey before importing the events module so its
// constants are bound at module-load time. We will pre-load the admin key
// pair via dynamic import inside the test.
const adminKp = generateEd25519KeyPair();
const ADMIN_HEX = publicKeyToRawHex(adminKp.publicKey);

vi.mock("./store.ts", () => {
  type FakeCore = {
    entries: string[];
    ready: () => Promise<void>;
    length: number;
    get: (i: number, opts?: { wait?: boolean }) => Promise<string | null>;
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
      async get(i) { return entries[i] ?? null; },
      async append(data) { entries.push(data); },
      key: Buffer.alloc(32, 1),
      async update() {},
    };
  }
  return {
    getCorestore: async () => ({
      namespace: () => ({
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
    }),
    closeCorestore: async () => {},
  };
});

vi.mock("../../shared/constants.ts", () => ({
  ADMIN_PUBKEY: ADMIN_HEX,
  ADMIN_LEDGER_KEY: "",
  LEDGER_TOPIC: Buffer.alloc(32),
}));

const { appendEvent, getLocalBalance } = await import("./events.ts");

interface Identity { priv: KeyObject; pub: KeyObject; hex: string; }
function newIdentity(): Identity {
  const { privateKey, publicKey } = generateEd25519KeyPair();
  return { priv: privateKey, pub: publicKey, hex: publicKeyToRawHex(publicKey) };
}

function signedSpend(owner: Identity, counterparty: Identity, amount: number, taskId: string, nonce = 0): Event {
  const base = {
    type: "spend" as const, nonce, timestamp: "2024-01-01T00:00:00Z", signature: "",
    task_id: taskId, amount, counterparty_pubkey: counterparty.hex,
    counterparty_task_signature: "",
  };
  const sig = signEd25519(canonicalStringify(eventWithoutSignature(base as Event)), owner.priv);
  return { ...base, signature: sig };
}

function signedEarn(owner: Identity, counterparty: Identity, amount: number, taskId: string, nonce = 0): Event {
  const base = {
    type: "earn" as const, nonce, timestamp: "2024-01-01T00:00:00Z", signature: "",
    task_id: taskId, amount, counterparty_pubkey: counterparty.hex,
    counterparty_task_signature: "",
  };
  const sig = signEd25519(canonicalStringify(eventWithoutSignature(base as Event)), counterparty.priv);
  return { ...base, signature: sig };
}

async function adminMint(recipient: Identity, amount: number, nonce: number): Promise<void> {
  const base = {
    type: "mint" as const, nonce, timestamp: "2024-01-01T00:00:00Z", signature: "",
    amount, recipient_pubkey: recipient.hex,
    signer_pubkey: ADMIN_HEX, reason: "signup",
  };
  const sig = signEd25519(canonicalStringify(eventWithoutSignature(base as unknown as Event)), adminKp.privateKey);
  await appendEvent(ADMIN_HEX, { ...base, signature: sig } as unknown as Event);
}

describe("ledger identity binding (admin mint required for earn cross-ref)", () => {
  it("REJECTS earn whose counterparty has no admin mint (trivial forgery)", async () => {
    // Attacker = owner. Throwaway = fake counterparty (no admin mint).
    const owner = newIdentity();
    const throwaway = newIdentity();
    // Self-sign a spend in throwaway's core, then claim a matching earn.
    await appendEvent(throwaway.hex, signedSpend(throwaway, owner, 999, "tA"));
    await appendEvent(owner.hex, signedEarn(owner, throwaway, 999, "tA"));
    // No admin mint for `throwaway` → cross-ref must reject the earn.
    expect(await getLocalBalance(owner.hex)).toBe(0);
  });

  it("ACCEPTS earn whose counterparty has a valid admin mint", async () => {
    const owner = newIdentity();
    const peer = newIdentity();
    await adminMint(peer, 50, 0);
    await appendEvent(peer.hex, signedSpend(peer, owner, 25, "tB"));
    await appendEvent(owner.hex, signedEarn(owner, peer, 25, "tB"));
    expect(await getLocalBalance(owner.hex)).toBe(25);
  });

  it("REJECTS earn after admin-minted counterparty's mint is removed", async () => {
    // Two earns from the same counterparty: first is mint-backed (accepted),
    // second references a different counterparty without a mint (rejected).
    const owner = newIdentity();
    const minted = newIdentity();
    const fake = newIdentity();
    await adminMint(minted, 10, 0);
    await appendEvent(minted.hex, signedSpend(minted, owner, 10, "tC"));
    await appendEvent(fake.hex, signedSpend(fake, owner, 10, "tD"));
    await appendEvent(owner.hex, signedEarn(owner, minted, 10, "tC", 0));
    await appendEvent(owner.hex, signedEarn(owner, fake, 10, "tD", 1));
    expect(await getLocalBalance(owner.hex)).toBe(10); // only minted earn counts
  });
});
