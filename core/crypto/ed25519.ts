/**
 * Ed25519 key generation, signing, and verification.
 * Used for Hypercore log signing and challenge-response authentication.
 * Uses Node's crypto module (works in Bun).
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";

export interface Ed25519KeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
}

export function publicKeyToRawHex(publicKey: KeyObject): string {
  const raw = publicKey.export({ format: "jwk" });
  if (!raw.x) throw new Error("Ed25519 public key missing x coordinate");
  const bytes = base64UrlToBytes(raw.x);
  return bytesToHex(bytes);
}

export function privateKeyToRawHex(privateKey: KeyObject): string {
  const raw = privateKey.export({ format: "jwk" });
  if (!raw.d) throw new Error("Ed25519 private key missing d coordinate");
  const bytes = base64UrlToBytes(raw.d);
  return bytesToHex(bytes);
}

export function rawHexToPublicKey(hex: string): KeyObject {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${bytes.length}`);
  }
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: bytesToBase64Url(bytes),
    },
    format: "jwk",
  });
}

export function rawHexToPrivateKey(hex: string): KeyObject {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) {
    throw new Error(`Ed25519 private key must be 32 bytes, got ${bytes.length}`);
  }
  // Import via PKCS8 DER so Node derives the correct matching public key.
  const privDer = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"), // PKCS8 header for Ed25519
    Buffer.from(bytes),
  ]);
  return createPrivateKey({ key: privDer, format: "der", type: "pkcs8" });
}

export function exportEd25519PrivatePem(privateKey: KeyObject): string {
  return privateKey.export({ format: "pem", type: "pkcs8" }) as string;
}

export function exportEd25519PublicPem(publicKey: KeyObject): string {
  return publicKey.export({ format: "pem", type: "spki" }) as string;
}

export function importEd25519PrivatePem(pem: string): KeyObject {
  return createPrivateKey({ key: pem, format: "pem" });
}

export function importEd25519PublicPem(pem: string): KeyObject {
  return createPublicKey({ key: pem, format: "pem" });
}

export function signEd25519(
  message: Uint8Array | string,
  privateKey: KeyObject,
): string {
  const buf = typeof message === "string"
    ? new TextEncoder().encode(message)
    : message;
  const sig = nodeSign(null, buf, privateKey);
  return bytesToHex(new Uint8Array(sig));
}

export function verifyEd25519(
  message: Uint8Array | string,
  signatureHex: string,
  publicKey: KeyObject,
): boolean {
  const buf = typeof message === "string"
    ? new TextEncoder().encode(message)
    : message;
  const sig = hexToBytes(signatureHex);
  return nodeVerify(null, buf, publicKey, sig);
}

// --- encoding helpers ---

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Hex string must have even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
