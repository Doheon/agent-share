import { test, expect } from "vitest";
import {
  generateEd25519KeyPair,
  signEd25519,
  verifyEd25519,
  publicKeyToRawHex,
  privateKeyToRawHex,
  rawHexToPublicKey,
  rawHexToPrivateKey,
  exportEd25519PrivatePem,
  exportEd25519PublicPem,
  importEd25519PrivatePem,
  importEd25519PublicPem,
  bytesToHex,
  hexToBytes,
} from "./ed25519.ts";

test("generate produces 32-byte keys", () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  expect(publicKeyToRawHex(publicKey).length).toBe(64);
  expect(privateKeyToRawHex(privateKey).length).toBe(64);
});

test("sign then verify succeeds with correct key", () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const sig = signEd25519("hello world", privateKey);
  expect(verifyEd25519("hello world", sig, publicKey)).toBe(true);
});

test("verify fails with tampered message", () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const sig = signEd25519("hello", privateKey);
  expect(verifyEd25519("hello!", sig, publicKey)).toBe(false);
});

test("verify fails with wrong public key", () => {
  const a = generateEd25519KeyPair();
  const b = generateEd25519KeyPair();
  const sig = signEd25519("msg", a.privateKey);
  expect(verifyEd25519("msg", sig, b.publicKey)).toBe(false);
});

test("raw hex round-trip for public key", () => {
  const { publicKey } = generateEd25519KeyPair();
  const hex = publicKeyToRawHex(publicKey);
  const roundtripped = rawHexToPublicKey(hex);
  expect(publicKeyToRawHex(roundtripped)).toBe(hex);
});

test("raw hex round-trip for private key (sign compatibility)", () => {
  const { privateKey, publicKey } = generateEd25519KeyPair();
  const hex = privateKeyToRawHex(privateKey);
  const rebuilt = rawHexToPrivateKey(hex);
  const sig = signEd25519("data", rebuilt);
  expect(verifyEd25519("data", sig, publicKey)).toBe(true);
});

test("PEM round-trip", () => {
  const { privateKey, publicKey } = generateEd25519KeyPair();
  const privPem = exportEd25519PrivatePem(privateKey);
  const pubPem = exportEd25519PublicPem(publicKey);
  const priv2 = importEd25519PrivatePem(privPem);
  const pub2 = importEd25519PublicPem(pubPem);
  const sig = signEd25519("pem-test", priv2);
  expect(verifyEd25519("pem-test", sig, pub2)).toBe(true);
});

test("hex encoding round-trip", () => {
  const bytes = new Uint8Array([0, 1, 15, 16, 255]);
  const hex = bytesToHex(bytes);
  expect(hex).toBe("00010f10ff");
  expect(Array.from(hexToBytes(hex))).toEqual(Array.from(bytes));
});
