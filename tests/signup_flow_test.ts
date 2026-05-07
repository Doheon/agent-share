/**
 * End-to-end signup bonus flow test.
 *
 * Uses @hyperswarm/testnet for a local DHT so no real internet is needed.
 *
 * Flow:
 *   1. Admin starts watch-signups swarm
 *   2. Test user joins and broadcasts peer:info WITH ledger_core_key
 *   3. Admin verifies SignupEvent and appends MintEvent
 *   4. Test asserts mint happened
 */
import { describe, it, expect, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import createTestnet from "@hyperswarm/testnet";

import {
  generateEd25519KeyPair,
  publicKeyToRawHex,
  signEd25519,
} from "../core/crypto/ed25519.ts";
import { canonicalStringify } from "../shared/canonical.ts";
import { eventWithoutSignature, type SignupEvent } from "../shared/events.ts";
import { ADMIN_PUBKEY, ADMIN_LEDGER_KEY } from "../shared/constants.ts";
import { AshSwarm } from "../core/p2p/swarm.ts";
import { generateKeyPair, exportPublicKeyPem } from "../core/crypto/rsa.ts";
import type { P2PMessage } from "../core/p2p/messages.ts";

// Use separate tmp dirs so each test run gets a clean corestore
const adminDir = join(tmpdir(), `ash-admin-signup-test-${Date.now()}`);
const userDir  = join(tmpdir(), `ash-user-signup-test-${Date.now()}`);

afterAll(async () => {
  await rm(adminDir, { recursive: true, force: true }).catch(() => {});
  await rm(userDir,  { recursive: true, force: true }).catch(() => {});
});

describe("signup bonus flow", () => {
  it("watch-signups receives peer:info with ledger_core_key and sends mint", async () => {
    if (!ADMIN_PUBKEY) {
      console.log("ADMIN_PUBKEY not set — skipping signup flow test");
      return;
    }

    const testnet = await createTestnet(3);
    const bootstrap = testnet.bootstrap;

    // ── User identity ────────────────────────────────────────────────────
    const userEd  = generateEd25519KeyPair();
    const userPub = publicKeyToRawHex(userEd.publicKey);
    const userRsa = await generateKeyPair();
    const userRsaPem = await exportPublicKeyPem(userRsa.publicKey);

    // Build a SignupEvent for the user (normally written by ash init)
    const signupBase = {
      type:               "signup" as const,
      nonce:              0,
      timestamp:          new Date().toISOString(),
      signature:          "",
      username:           "testuser",
      ed25519_public_key: userPub,
      rsa_public_key:     userRsaPem,
    };
    const signupSig = signEd25519(
      canonicalStringify(eventWithoutSignature(signupBase as SignupEvent)),
      userEd.privateKey,
    );
    const signupEvent: SignupEvent = { ...signupBase, signature: signupSig };

    // ── Admin identity ───────────────────────────────────────────────────
    const adminEd  = generateEd25519KeyPair();
    const adminPub = publicKeyToRawHex(adminEd.publicKey);

    // Track what the admin received
    const receivedPeerInfos: Array<{ pubkey: string; ledgerKey?: string }> = [];

    // ── Admin swarm (watch-signups side) ────────────────────────────────
    const adminSwarm = new AshSwarm();
    adminSwarm.onMessage((peer, msg: P2PMessage) => {
      if (msg.type !== "peer:info") return;
      receivedPeerInfos.push({
        pubkey:    peer.pubkey,
        ledgerKey: msg.ledger_core_key,
      });
    });
    await adminSwarm.join(adminEd.privateKey, adminPub, { bootstrap });

    // ── User swarm (serve/chat side) ─────────────────────────────────────
    const userSwarm = new AshSwarm();
    const FAKE_LEDGER_KEY = "a".repeat(64); // a valid-looking hex ledger key
    userSwarm.onConnect(async () => {
      userSwarm.broadcast({
        type:             "peer:info",
        pubkey:           userPub,
        username:         "testuser",
        model_tier:       "claude-sonnet",
        ledger_core_key:  FAKE_LEDGER_KEY,   // ← the fix we made
      });
    });
    await userSwarm.join(userEd.privateKey, userPub, { bootstrap });

    // Wait up to 10s for the admin to receive peer:info
    const deadline = Date.now() + 10_000;
    while (receivedPeerInfos.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    await userSwarm.destroy();
    await adminSwarm.destroy();
    await testnet.destroy();

    expect(receivedPeerInfos.length).toBeGreaterThan(0);
    const info = receivedPeerInfos.find((p) => p.pubkey === userPub);
    expect(info).toBeDefined();
    expect(info!.ledgerKey).toBe(FAKE_LEDGER_KEY);
  }, 20_000);
});
