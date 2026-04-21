import { describe, it, expect, vi } from "vitest";

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
    _cores: cores,
  };
  return {
    getCorestore: async () => fakeStore,
    closeCorestore: async () => {},
  };
});

vi.mock("../../shared/constants.ts", () => ({
  ADMIN_PUBKEY: "",
  ADMIN_LEDGER_KEY: "",
  LEDGER_TOPIC: Buffer.alloc(32),
}));

import type { KeyObject } from "node:crypto";
import { appendEvent, getEventCount, getLocalBalance, getEvents } from "./events.ts";
import { type Event, eventWithoutSignature } from "../../shared/events.ts";
import {
  generateEd25519KeyPair,
  publicKeyToRawHex,
  signEd25519,
} from "../../core/crypto/ed25519.ts";
import { canonicalStringify } from "../../shared/canonical.ts";

interface Identity {
  priv: KeyObject;
  pub: KeyObject;
  hex: string;
}

function newIdentity(): Identity {
  const { privateKey, publicKey } = generateEd25519KeyPair();
  return { priv: privateKey, pub: publicKey, hex: publicKeyToRawHex(publicKey) };
}

/**
 * Builds a signed SpendEvent belonging to `owner`'s log, with `counterparty`
 * recorded as the recipient. Signed by owner.
 */
function signedSpend(
  owner: Identity,
  counterparty: Identity,
  amount: number,
  taskId: string,
  nonce = 0,
): Event {
  const base = {
    type: "spend" as const,
    nonce,
    timestamp: "2024-01-01T00:00:00Z",
    signature: "",
    task_id: taskId,
    amount,
    counterparty_pubkey: counterparty.hex,
    counterparty_task_signature: "",
  };
  const sig = signEd25519(canonicalStringify(eventWithoutSignature(base as Event)), owner.priv);
  return { ...base, signature: sig };
}

/**
 * Builds a signed EarnEvent belonging to `owner`'s log. The event is signed
 * by `counterparty` (the payer) because replay verifies the earn signature
 * against `counterparty_pubkey`.
 */
function signedEarn(
  owner: Identity,
  counterparty: Identity,
  amount: number,
  taskId: string,
  nonce = 0,
): Event {
  const base = {
    type: "earn" as const,
    nonce,
    timestamp: "2024-01-01T00:00:00Z",
    signature: "",
    task_id: taskId,
    amount,
    counterparty_pubkey: counterparty.hex,
    counterparty_task_signature: "",
  };
  const sig = signEd25519(canonicalStringify(eventWithoutSignature(base as Event)), counterparty.priv);
  return { ...base, signature: sig };
}

/**
 * Wires up a legitimate earn on `owner`'s log: appends a matching
 * SpendEvent on `counterparty`'s log first (so cross-ref succeeds), then
 * returns the signed EarnEvent ready to append to `owner`.
 */
async function pairedEarn(
  owner: Identity,
  counterparty: Identity,
  amount: number,
  taskId: string,
): Promise<Event> {
  const spend = signedSpend(counterparty, owner, amount, taskId);
  await appendEvent(counterparty.hex, spend);
  return signedEarn(owner, counterparty, amount, taskId);
}

describe("ledger events — replay hardening", () => {
  it("1: getEventCount returns 0 for a new user", async () => {
    const u = newIdentity();
    expect(await getEventCount(u.hex)).toBe(0);
  });

  it("2: appendEvent + getEventCount increments count", async () => {
    const a = newIdentity();
    const b = newIdentity();
    const e1 = await pairedEarn(a, b, 10, "t2a");
    await appendEvent(a.hex, e1);
    expect(await getEventCount(a.hex)).toBe(1);
    const e2 = await pairedEarn(a, b, 20, "t2b");
    await appendEvent(a.hex, e2);
    expect(await getEventCount(a.hex)).toBe(2);
  });

  it("3: getLocalBalance is 0 for new user", async () => {
    const u = newIdentity();
    expect(await getLocalBalance(u.hex)).toBe(0);
  });

  it("4: a properly co-signed earn increases balance", async () => {
    const a = newIdentity();
    const b = newIdentity();
    const earn = await pairedEarn(a, b, 100, "t4");
    await appendEvent(a.hex, earn);
    expect(await getLocalBalance(a.hex)).toBe(100);
  });

  it("5: self-signed spend by owner decreases balance after earn", async () => {
    const a = newIdentity();
    const b = newIdentity();
    const earn = await pairedEarn(a, b, 100, "t5a");
    await appendEvent(a.hex, earn);
    const spend = signedSpend(a, b, 40, "t5b", 1);
    await appendEvent(a.hex, spend);
    expect(await getLocalBalance(a.hex)).toBe(60);
  });

  it("6: multiple earn+spend — +50, +30, -20 => 60", async () => {
    const a = newIdentity();
    const b = newIdentity();
    const e1 = await pairedEarn(a, b, 50, "t6a");
    const e2 = await pairedEarn(a, b, 30, "t6b");
    const s1 = signedSpend(a, b, 20, "t6c", 2);
    await appendEvent(a.hex, e1);
    await appendEvent(a.hex, e2);
    await appendEvent(a.hex, s1);
    expect(await getLocalBalance(a.hex)).toBe(60);
  });

  it("7: malformed JSON entry is skipped, valid earn still counted", async () => {
    const a = newIdentity();
    const b = newIdentity();
    const { getCorestore } = await import("./store.ts");
    const store = await getCorestore() as unknown as {
      namespace: (ns: string) => { get: (opts: { name: string }) => { ready: () => Promise<void>; entries: string[] } };
    };
    const core = store.namespace("ash-events").get({ name: a.hex });
    await core.ready();
    core.entries.push("not valid json {{");
    const earn = await pairedEarn(a, b, 75, "t7");
    await appendEvent(a.hex, earn);
    expect(await getLocalBalance(a.hex)).toBe(75);
  });

  it("8: getEvents returns all appended events in order", async () => {
    const a = newIdentity();
    const b = newIdentity();
    const e1 = await pairedEarn(a, b, 10, "t8a");
    const s1 = signedSpend(a, b, 5, "t8b", 1);
    const e2 = await pairedEarn(a, b, 20, "t8c");
    await appendEvent(a.hex, e1);
    await appendEvent(a.hex, s1);
    await appendEvent(a.hex, e2);
    const events = await getEvents(a.hex);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(e1);
    expect(events[1]).toEqual(s1);
    expect(events[2]).toEqual(e2);
  });

  // ─── Forgery defenses ─────────────────────────────────────────────────────

  it("9: earn with no matching spend on counterparty's log is rejected", async () => {
    const a = newIdentity();
    const b = newIdentity(); // no spend appended to b's log
    const earn = signedEarn(a, b, 500, "t9");
    await appendEvent(a.hex, earn);
    expect(await getLocalBalance(a.hex)).toBe(0);
  });

  it("10: earn signed by wrong key is rejected", async () => {
    const a = newIdentity();
    const b = newIdentity();
    const attacker = newIdentity();
    // Counterparty has a legitimate spend, but the earn is signed by the
    // attacker instead of b — signature verification fails.
    await appendEvent(b.hex, signedSpend(b, a, 200, "t10"));
    const base = {
      type: "earn" as const,
      nonce: 0,
      timestamp: "2024-01-01T00:00:00Z",
      signature: "",
      task_id: "t10",
      amount: 200,
      counterparty_pubkey: b.hex,
      counterparty_task_signature: "",
    };
    const sig = signEd25519(canonicalStringify(eventWithoutSignature(base as Event)), attacker.priv);
    await appendEvent(a.hex, { ...base, signature: sig });
    expect(await getLocalBalance(a.hex)).toBe(0);
  });

  it("11: spend signed by foreign key is skipped (not deducted)", async () => {
    const a = newIdentity();
    const b = newIdentity();
    const foreign = newIdentity();
    // Seed a legitimate balance first.
    const earn = await pairedEarn(a, b, 100, "t11a");
    await appendEvent(a.hex, earn);
    // Foreign spend — signed by `foreign`, not `a`. Must not apply.
    const base = {
      type: "spend" as const,
      nonce: 1,
      timestamp: "2024-01-01T00:00:00Z",
      signature: "",
      task_id: "t11b",
      amount: 30,
      counterparty_pubkey: b.hex,
      counterparty_task_signature: "",
    };
    const sig = signEd25519(canonicalStringify(eventWithoutSignature(base as Event)), foreign.priv);
    await appendEvent(a.hex, { ...base, signature: sig });
    expect(await getLocalBalance(a.hex)).toBe(100);
  });

  it("12: spend that would drive balance negative is skipped", async () => {
    const a = newIdentity();
    const b = newIdentity();
    // Balance starts at 0. A self-signed spend for 50 must not make it -50.
    const spend = signedSpend(a, b, 50, "t12");
    await appendEvent(a.hex, spend);
    expect(await getLocalBalance(a.hex)).toBe(0);
  });

  it("13: earn matches spend amount and task_id — amount mismatch rejects", async () => {
    const a = newIdentity();
    const b = newIdentity();
    // Counterparty spent 10, but earn claims 100 for the same task → cross-ref
    // fails because ev.amount >= earn.amount does not hold.
    await appendEvent(b.hex, signedSpend(b, a, 10, "t13"));
    const earn = signedEarn(a, b, 100, "t13");
    await appendEvent(a.hex, earn);
    expect(await getLocalBalance(a.hex)).toBe(0);
  });
});
