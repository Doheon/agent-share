/**
 * Creates a test profile at a given ASH_DIR without interactive prompts.
 * Usage: ASH_DIR=~/.ash-bob node --import tsx/esm scripts/setup-test-profile.ts bob
 */

import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const username = process.argv[2];
if (!username) { console.error("Usage: setup-test-profile.ts <username>"); process.exit(1); }

const ASH_DIR = process.env.ASH_DIR ?? join(homedir(), ".ash");
const KEYS_DIR = join(ASH_DIR, "keys");
const RSA_DIR = join(KEYS_DIR, "rsa");

// ── Ed25519 ──────────────────────────────────────────────────────────────────
import {
  generateEd25519KeyPair,
  exportEd25519PrivatePem,
  exportEd25519PublicPem,
  publicKeyToRawHex,
  signEd25519,
} from "../core/crypto/ed25519.ts";

// ── RSA ──────────────────────────────────────────────────────────────────────
import { generateKeyPair, exportPublicKeyPem, exportPrivateKeyPem } from "../core/crypto/rsa.ts";

// ── Ledger ───────────────────────────────────────────────────────────────────
import { canonicalStringify } from "../shared/canonical.ts";
import { eventWithoutSignature, type SignupEvent } from "../shared/events.ts";

// Must set ASH_DIR before importing store-dependent modules
process.env.ASH_DIR = ASH_DIR;
const { appendLocalEvent, closeLocalStore, getNextNonce } = await import("../cli/p2p_state.ts");

await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 });
await mkdir(RSA_DIR,  { recursive: true, mode: 0o700 });

// 1. Ed25519 identity keypair
const ed = generateEd25519KeyPair();
const pubHex = publicKeyToRawHex(ed.publicKey);
const privPem = exportEd25519PrivatePem(ed.privateKey);
const pubPem  = exportEd25519PublicPem(ed.publicKey);

await writeFile(join(KEYS_DIR, "identity.ed25519"),      privPem, { mode: 0o600 });
await writeFile(join(KEYS_DIR, "identity.ed25519.pub"),  pubPem,  { mode: 0o644 });

// 2. RSA keypair for AES key exchange
const rsa = await generateKeyPair();
const rsaPrivPem = await exportPrivateKeyPem(rsa.privateKey);
const rsaPubPem  = await exportPublicKeyPem(rsa.publicKey);

await writeFile(join(RSA_DIR, `${pubHex}.pem`),     rsaPrivPem, { mode: 0o600 });
await writeFile(join(RSA_DIR, `${pubHex}.pub.pem`), rsaPubPem,  { mode: 0o644 });

// 3. config.json
await writeFile(
  join(ASH_DIR, "config.json"),
  JSON.stringify({ username, pubkey: pubHex, modelTier: "claude-sonnet", agent: "claude" }, null, 2),
  { mode: 0o600 },
);

// 4. SignupEvent in Hypercore
const nonce = await getNextNonce(pubHex);
const base = {
  type: "signup" as const,
  nonce,
  timestamp: new Date().toISOString(),
  signature: "",
  username,
  ed25519_public_key: pubHex,
  rsa_public_key: rsaPubPem,
};
const sig = signEd25519(canonicalStringify(eventWithoutSignature(base as SignupEvent)), ed.privateKey);
await appendLocalEvent(pubHex, { ...base, signature: sig });
await closeLocalStore().catch(() => undefined);

console.log(`✓ profile '${username}' created at ${ASH_DIR}`);
console.log(`  pubkey: ${pubHex}`);
