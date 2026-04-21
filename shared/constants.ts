import { createHash } from "node:crypto";

// Ed25519 public key hex of the admin node.
// Admin can issue MintEvent and PolicyUpdateEvent.
// Set to a non-empty string to enable admin-only event verification.
export const ADMIN_PUBKEY = "156ad2c34700afcdcfb067ab34d30440e2590baa2c12c9590c5c4e793e1df6ba";

// Actual Hypercore key of the admin's event core (from the admin's Corestore).
// Peers use this key to replicate the admin core and verify MintEvents.
// Run 'ash admin pubkey' after keygen to get this value.
export const ADMIN_LEDGER_KEY = "372ef059418a318ac5ad8c02db159693352de909a07283f3fa9fe319740937a3";

// Hyperswarm topic for the global ledger replication network.
// All ash peers join this topic so each user's event Hypercore
// is replicated to all connected peers.
export const LEDGER_TOPIC: Buffer = createHash("sha256")
  .update("ash-global-ledger-v1")
  .digest();
