/**
 * Unit tests for RSA-OAEP key generation and AES key exchange (core/crypto/rsa.ts)
 */

import { test, expect } from "vitest";
import {
  decryptAesKey,
  encryptAesKey,
  exportPrivateKeyPem,
  exportPublicKeyPem,
  generateKeyPair,
  importPrivateKeyPem,
  importPublicKeyPem,
} from "./rsa.ts";
import { exportKey, generateKey } from "./aes.ts";

test("generateKeyPair returns a public and private CryptoKey", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  expect(publicKey.type).toEqual("public");
  expect(privateKey.type).toEqual("private");
  expect(publicKey.algorithm.name).toEqual("RSA-OAEP");
  expect(privateKey.algorithm.name).toEqual("RSA-OAEP");
});

test("generateKeyPair produces 2048-bit RSA keys", async () => {
  const { publicKey } = await generateKeyPair();
  expect((publicKey.algorithm as RsaHashedKeyAlgorithm).modulusLength).toEqual(2048);
});

test("exportPublicKeyPem produces PEM with correct header and footer", async () => {
  const { publicKey } = await generateKeyPair();
  const pem = await exportPublicKeyPem(publicKey);
  expect(pem.startsWith("-----BEGIN PUBLIC KEY-----")).toEqual(true);
  expect(pem.endsWith("-----END PUBLIC KEY-----")).toEqual(true);
});

test("exportPrivateKeyPem produces PEM with correct header and footer", async () => {
  const { privateKey } = await generateKeyPair();
  const pem = await exportPrivateKeyPem(privateKey);
  expect(pem.startsWith("-----BEGIN PRIVATE KEY-----")).toEqual(true);
  expect(pem.endsWith("-----END PRIVATE KEY-----")).toEqual(true);
});

test("exportPublicKeyPem then importPublicKeyPem roundtrip preserves key type", async () => {
  const { publicKey } = await generateKeyPair();
  const pem = await exportPublicKeyPem(publicKey);
  const imported = await importPublicKeyPem(pem);
  expect(imported.type).toEqual("public");
  expect(imported.algorithm.name).toEqual("RSA-OAEP");
});

test("exportPrivateKeyPem then importPrivateKeyPem roundtrip preserves key type", async () => {
  const { privateKey } = await generateKeyPair();
  const pem = await exportPrivateKeyPem(privateKey);
  const imported = await importPrivateKeyPem(pem);
  expect(imported.type).toEqual("private");
  expect(imported.algorithm.name).toEqual("RSA-OAEP");
});

test("imported public key can encrypt data that imported private key decrypts", async () => {
  const pair = await generateKeyPair();
  const pubPem = await exportPublicKeyPem(pair.publicKey);
  const privPem = await exportPrivateKeyPem(pair.privateKey);

  const importedPub = await importPublicKeyPem(pubPem);
  const importedPriv = await importPrivateKeyPem(privPem);

  const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    importedPub,
    plaintext,
  );
  const decrypted = new Uint8Array(
    await crypto.subtle.decrypt({ name: "RSA-OAEP" }, importedPriv, encrypted),
  );
  expect(decrypted).toEqual(plaintext);
});

test("encryptAesKey then decryptAesKey roundtrip returns original raw key bytes", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const aesKey = await generateKey();
  const aesKeyRaw = await exportKey(aesKey);

  const encryptedB64 = await encryptAesKey(aesKeyRaw, publicKey);
  const decryptedRaw = await decryptAesKey(encryptedB64, privateKey);

  expect(decryptedRaw).toEqual(aesKeyRaw);
});

test("encryptAesKey returns a non-empty base64 string", async () => {
  const { publicKey } = await generateKeyPair();
  const aesKey = await generateKey();
  const aesKeyRaw = await exportKey(aesKey);

  const encryptedB64 = await encryptAesKey(aesKeyRaw, publicKey);
  expect(encryptedB64.length).not.toEqual(0);
  // Should be valid base64 (no spaces/non-base64 chars aside from padding)
  expect(/^[A-Za-z0-9+/]+=*$/.test(encryptedB64)).toEqual(true);
});

test("decryptAesKey with wrong private key throws an error", async () => {
  const { publicKey } = await generateKeyPair();
  const { privateKey: wrongPrivateKey } = await generateKeyPair();

  const aesKey = await generateKey();
  const aesKeyRaw = await exportKey(aesKey);
  const encryptedB64 = await encryptAesKey(aesKeyRaw, publicKey);

  await expect(() => decryptAesKey(encryptedB64, wrongPrivateKey)).rejects.toThrow();
});

test("two calls to generateKeyPair produce different key material", async () => {
  const pair1 = await generateKeyPair();
  const pair2 = await generateKeyPair();

  const pub1 = await exportPublicKeyPem(pair1.publicKey);
  const pub2 = await exportPublicKeyPem(pair2.publicKey);
  expect(pub1).not.toEqual(pub2);
});
