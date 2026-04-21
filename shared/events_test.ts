/**
 * Unit tests for shared/events.ts
 *
 * Focuses on eventWithoutSignature(): it must strip the signature field,
 * keep every other field intact (including optional signer_pubkey), and
 * never mutate the original event.
 */

import { test, expect } from "vitest";
import {
  eventWithoutSignature,
  type EarnEvent,
  type SignupEvent,
  type TaskCreatedEvent,
} from "./events.ts";

function makeSignup(): SignupEvent {
  return {
    type: "signup",
    nonce: 0,
    timestamp: "2026-04-20T00:00:00Z",
    signature: "deadbeefsig",
    username: "alice",
    ed25519_public_key: "abcd1234",
    rsa_public_key: "-----BEGIN PUBLIC KEY-----\nXYZ\n-----END PUBLIC KEY-----",
  };
}

function makeEarnWithSignerPubkey(): EarnEvent {
  return {
    type: "earn",
    nonce: 5,
    timestamp: "2026-04-20T01:00:00Z",
    signature: "originalSig",
    signer_pubkey: "serverPub",
    amount: 10,
    task_id: "t-42",
    counterparty_pubkey: "counterpartyPub",
    counterparty_task_signature: "counterpartySig",
  };
}

test("removes the signature field", () => {
  const e = makeSignup();
  const stripped = eventWithoutSignature(e);
  expect("signature" in stripped).toEqual(false);
});

test("preserves every non-signature field", () => {
  const e = makeSignup();
  const stripped = eventWithoutSignature(e) as Omit<SignupEvent, "signature">;

  expect(stripped.type).toEqual(e.type);
  expect(stripped.nonce).toEqual(e.nonce);
  expect(stripped.timestamp).toEqual(e.timestamp);
  expect(stripped.username).toEqual(e.username);
  expect(stripped.ed25519_public_key).toEqual(e.ed25519_public_key);
  expect(stripped.rsa_public_key).toEqual(e.rsa_public_key);
});

test("preserves signer_pubkey when present (server-co-signed events)", () => {
  const e = makeEarnWithSignerPubkey();
  const stripped = eventWithoutSignature(e) as Omit<EarnEvent, "signature">;

  expect("signature" in stripped).toEqual(false);
  expect(stripped.signer_pubkey).toEqual("serverPub");
  expect(stripped.amount).toEqual(10);
  expect(stripped.task_id).toEqual("t-42");
  expect(stripped.counterparty_pubkey).toEqual("counterpartyPub");
  expect(stripped.counterparty_task_signature).toEqual("counterpartySig");
});

test("does not mutate the original event object", () => {
  const e = makeSignup();
  const snapshot = JSON.parse(JSON.stringify(e));

  eventWithoutSignature(e);

  expect(e).toEqual(snapshot);
  expect(e.signature).toEqual("deadbeefsig");
});

test("returns a new object (reference inequality)", () => {
  const e = makeSignup();
  const stripped = eventWithoutSignature(e);
  expect(stripped).not.toBe(e as unknown as object);
});

test("works for events with array fields (task_created allowed_hosts)", () => {
  const e: TaskCreatedEvent = {
    type: "task_created",
    nonce: 2,
    timestamp: "2026-04-20T00:00:00Z",
    signature: "tcs",
    task_id: "t-1",
    prompt: "do it",
    credit_amount: 100,
    model: "claude",
    blob_key: "blob",
    allowed_hosts: ["example.com", "api.example.com"],
  };
  const stripped = eventWithoutSignature(e) as Omit<TaskCreatedEvent, "signature">;
  expect("signature" in stripped).toEqual(false);
  expect(stripped.allowed_hosts).toEqual(["example.com", "api.example.com"]);
});
