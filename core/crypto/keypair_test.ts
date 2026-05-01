/**
 * Unit tests for core/crypto/keypair.ts
 *
 * Covers: hasKeyPair, createKeyPair, loadPrivateKey, getOrCreateKeyPair.
 * Key files are written to the real KEYS_DIR (~/.agent-share/keys) using
 * unique IDs and cleaned up in afterEach.
 */

import { test, expect, afterEach } from "vitest";
import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import {
  hasKeyPair,
  createKeyPair,
  loadPrivateKey,
  getOrCreateKeyPair,
} from "./keypair.ts";
import { ASH_DIR } from "../../cli/ash_dir.ts";

const KEYS_DIR = join(ASH_DIR, "keys", "rsa");

const testIds: string[] = [];

function newId(): string {
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  testIds.push(id);
  return id;
}

afterEach(async () => {
  for (const id of testIds.splice(0)) {
    await rm(join(KEYS_DIR, `${id}.pem`), { force: true });
    await rm(join(KEYS_DIR, `${id}.pub.pem`), { force: true });
  }
});

// ─── hasKeyPair ───────────────────────────────────────────────────────────────

test("hasKeyPair returns false for nonexistent userId", async () => {
  const id = newId();
  expect(await hasKeyPair(id)).toBe(false);
});

// ─── createKeyPair ────────────────────────────────────────────────────────────

test("createKeyPair writes key files and returns a valid keypair", async () => {
  const id = newId();
  const pair = await createKeyPair(id);
  expect(pair.privateKey).toBeDefined();
  expect(pair.publicKey).toBeDefined();
});

test("createKeyPair makes hasKeyPair return true afterward", async () => {
  const id = newId();
  await createKeyPair(id);
  expect(await hasKeyPair(id)).toBe(true);
});

test("createKeyPair private key file has restrictive permissions (0o600)", async () => {
  const id = newId();
  await createKeyPair(id);
  const keyFile = join(KEYS_DIR, `${id}.pem`);
  const s = await stat(keyFile);
  expect(s.mode & 0o777).toEqual(0o600);
});

// ─── loadPrivateKey ───────────────────────────────────────────────────────────

test("loadPrivateKey returns the saved private key with correct type and algorithm", async () => {
  const id = newId();
  await createKeyPair(id);
  const key = await loadPrivateKey(id);
  expect(key.type).toEqual("private");
  expect(key.algorithm.name).toEqual("RSA-OAEP");
});

test("loadPrivateKey throws with message containing 'Private key not found' for missing key", async () => {
  const id = newId();
  await expect(() => loadPrivateKey(id)).rejects.toThrow("Private key not found");
});

// ─── getOrCreateKeyPair ───────────────────────────────────────────────────────

test("getOrCreateKeyPair creates a new pair when none exists", async () => {
  const id = newId();
  expect(await hasKeyPair(id)).toBe(false);
  const pair = await getOrCreateKeyPair(id);
  expect(pair.privateKey).toBeDefined();
  expect(pair.publicKey).toBeDefined();
  expect(await hasKeyPair(id)).toBe(true);
});

test("getOrCreateKeyPair returns loadable pair on second call with matching algorithm", async () => {
  const id = newId();
  await getOrCreateKeyPair(id);
  const pair = await getOrCreateKeyPair(id);
  expect(pair.privateKey.algorithm.name).toEqual("RSA-OAEP");
  expect(pair.publicKey.algorithm.name).toEqual("RSA-OAEP");
});
