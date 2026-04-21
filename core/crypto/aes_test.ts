/**
 * Unit tests for AES-256-GCM encrypt/decrypt (core/crypto/aes.ts)
 */

import { test, expect } from "vitest";
import {
  decryptData,
  encryptData,
  exportKey,
  generateKey,
  importKey,
} from "./aes.ts";

test("generateKey returns a CryptoKey with AES-GCM algorithm", async () => {
  const key = await generateKey();
  expect(key.type).toEqual("secret");
  expect(key.algorithm.name).toEqual("AES-GCM");
  expect((key.algorithm as AesKeyAlgorithm).length).toEqual(256);
});

test("encryptData returns ciphertext, key, and iv", async () => {
  const data = new TextEncoder().encode("hello world");
  const result = await encryptData(data);

  expect(result.iv.length).toEqual(12);
  // Ciphertext must not be empty and is longer than plaintext (GCM tag adds 16 bytes)
  expect(result.ciphertext.length).not.toEqual(0);
  expect(result.key.type).toEqual("secret");
});

test("encrypt then decrypt roundtrip produces original plaintext", async () => {
  const original = new TextEncoder().encode("roundtrip test data");
  const { ciphertext, key, iv } = await encryptData(original);
  const decrypted = await decryptData(ciphertext, key, iv);
  expect(decrypted).toEqual(original);
});

test("encrypting the same data twice produces different ciphertext due to random iv", async () => {
  const data = new TextEncoder().encode("same data");
  const first = await encryptData(data);
  const second = await encryptData(data);
  // IVs should differ (random)
  expect(first.iv).not.toEqual(second.iv);
});

test("different keys produce different ciphertext for same plaintext", async () => {
  const data = new TextEncoder().encode("same plaintext");
  const { ciphertext: c1, iv: iv1 } = await encryptData(data);
  const { ciphertext: c2, iv: iv2 } = await encryptData(data);
  // With different random keys and IVs, ciphertexts must differ
  const bothSame = c1.length === c2.length &&
    c1.every((b, i) => b === c2[i]) &&
    iv1.every((b, i) => b === iv2[i]);
  expect(bothSame).toEqual(false);
});

test("decryption with wrong key throws an error", async () => {
  const data = new TextEncoder().encode("secret");
  const { ciphertext, iv } = await encryptData(data);
  const wrongKey = await generateKey();

  await expect(() => decryptData(ciphertext, wrongKey, iv)).rejects.toThrow();
});

test("decryption with wrong iv throws an error", async () => {
  const data = new TextEncoder().encode("secret");
  const { ciphertext, key } = await encryptData(data);
  const wrongIv = crypto.getRandomValues(new Uint8Array(12));

  await expect(() => decryptData(ciphertext, key, wrongIv)).rejects.toThrow();
});

test("exportKey returns a 32-byte Uint8Array for AES-256", async () => {
  const key = await generateKey();
  const raw = await exportKey(key);
  expect(raw.length).toEqual(32); // 256 bits = 32 bytes
});

test("exportKey then importKey roundtrip produces usable key", async () => {
  const original = new TextEncoder().encode("export-import test");
  const key = await generateKey();
  const raw = await exportKey(key);
  const imported = await importKey(raw);

  // Encrypt with original key, decrypt with imported key
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    original,
  );
  const ciphertext = new Uint8Array(ciphertextBuffer);
  const decrypted = await decryptData(ciphertext, imported, iv);
  expect(decrypted).toEqual(original);
});

test("importKey produces a CryptoKey with correct algorithm", async () => {
  const key = await generateKey();
  const raw = await exportKey(key);
  const imported = await importKey(raw);
  expect(imported.type).toEqual("secret");
  expect(imported.algorithm.name).toEqual("AES-GCM");
  expect((imported.algorithm as AesKeyAlgorithm).length).toEqual(256);
});

test("encrypt empty data and decrypt roundtrip", async () => {
  const empty = new Uint8Array(0);
  const { ciphertext, key, iv } = await encryptData(empty);
  const decrypted = await decryptData(ciphertext, key, iv);
  expect(decrypted).toEqual(empty);
});

test("encrypt large data and decrypt roundtrip", async () => {
  // getRandomValues is capped at 65536 bytes per call; build 1 MB by repeating
  const chunk = crypto.getRandomValues(new Uint8Array(65536));
  const large = new Uint8Array(1024 * 1024);
  for (let offset = 0; offset < large.length; offset += chunk.length) {
    large.set(chunk.slice(0, Math.min(chunk.length, large.length - offset)), offset);
  }
  const { ciphertext, key, iv } = await encryptData(large);
  const decrypted = await decryptData(ciphertext, key, iv);
  expect(decrypted).toEqual(large);
});
