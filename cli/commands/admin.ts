/**
 * ash admin — admin-only operations.
 *
 *   ash admin keygen                            Generate admin Ed25519 keypair
 *   ash admin mint <pubkey> <amount> [reason]   Mint credits for a user
 *   ash admin watch-signups                     Auto-mint SIGNUP_BONUS for new users
 *
 * The admin keypair is stored at ~/.ash/keys/admin.ed25519 (private, chmod 600)
 * and ~/.ash/keys/admin.ed25519.pub.
 *
 * After keygen, copy the printed ADMIN_PUBKEY value into shared/constants.ts
 * and redeploy so all peers recognize admin-signed MintEvents.
 *
 * MintEvents are stored in the admin's own Hypercore and replicated to peers
 * via LEDGER_TOPIC. Recipients credit the mint the next time they read their
 * balance — no need for the recipient to be online at mint time.
 */

import { Command } from "commander";
import { access, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import { ASH_DIR } from "../ash_dir.ts";
import {
  exportEd25519PrivatePem,
  exportEd25519PublicPem,
  generateEd25519KeyPair,
  importEd25519PrivatePem,
  importEd25519PublicPem,
  publicKeyToRawHex,
  rawHexToPublicKey,
  signEd25519,
  verifyEd25519,
} from "../../core/crypto/ed25519.ts";
import { canonicalStringify } from "../../shared/canonical.ts";
import { eventWithoutSignature, type Event, type MintEvent } from "../../shared/events.ts";
import { ADMIN_PUBKEY, LEDGER_TOPIC } from "../../shared/constants.ts";
import { appendEvent, getEventCount, getEvents } from "../../core/ledger/events.ts";
import { getCorestore, closeCorestore } from "../../core/ledger/store.ts";
import { AshSwarm } from "../../core/p2p/swarm.ts";
import { SIGNUP_BONUS } from "../../shared/policy.ts";

const KEYS_DIR = join(ASH_DIR, "keys");
const ADMIN_PRIV_PATH = join(KEYS_DIR, "admin.ed25519");
const ADMIN_PUB_PATH  = join(KEYS_DIR, "admin.ed25519.pub");

async function loadAdminPrivateKey() {
  try {
    const pem = await readFile(ADMIN_PRIV_PATH, "utf-8");
    return importEd25519PrivatePem(pem);
  } catch {
    throw new Error(`Admin keypair not found at ${ADMIN_PRIV_PATH}. Run: ash admin keygen`);
  }
}

export const adminCommand = new Command("admin")
  .description("Admin operations (requires admin keypair)");

adminCommand.addCommand(
  new Command("keygen")
    .description("Generate admin Ed25519 keypair")
    .action(async () => {
      try {
        let exists = false;
        try { await access(ADMIN_PRIV_PATH); exists = true; } catch { /* ok */ }

        if (exists) {
          const pubPem = await readFile(ADMIN_PUB_PATH, "utf-8");
          const pubkey = publicKeyToRawHex(importEd25519PublicPem(pubPem));
          console.log(`\n  Admin keypair already exists.\n`);
          console.log(`  ADMIN_PUBKEY = "${pubkey}"\n`);
          return;
        }

        await mkdir(KEYS_DIR, { recursive: true });
        const { publicKey, privateKey } = generateEd25519KeyPair();
        await writeFile(ADMIN_PRIV_PATH, exportEd25519PrivatePem(privateKey), { mode: 0o600 });
        await writeFile(ADMIN_PUB_PATH, exportEd25519PublicPem(publicKey));

        const pubkeyHex = publicKeyToRawHex(publicKey);
        console.log(`\n  Admin keypair generated.\n`);
        console.log(`  Private key: ${ADMIN_PRIV_PATH}  (keep secret!)\n`);
        console.log(`  Add to shared/constants.ts and rebuild:\n`);
        console.log(`    export const ADMIN_PUBKEY = "${pubkeyHex}";\n`);
      } catch (err) {
        console.error(`\nerror: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }),
);

adminCommand.addCommand(
  new Command("mint")
    .description("Mint credits for a recipient (admin keypair required)")
    .argument("<pubkey>", "Recipient Ed25519 pubkey hex")
    .argument("<amount>", "Credits to mint", parseInt)
    .argument("[reason]", "Human-readable reason", "admin grant")
    .option("--wait <ms>", "Milliseconds to wait for replication", parseInt, 5000)
    .action(async (
      recipientPubkey: string,
      amount: number,
      reason: string,
      opts: { wait: number },
    ) => {
      if (!ADMIN_PUBKEY) {
        console.error("\nerror: ADMIN_PUBKEY is not set in shared/constants.ts\n");
        console.error("  Run 'ash admin keygen', add the printed key to shared/constants.ts,\n  then rebuild.\n");
        process.exit(1);
      }

      try {
        const adminPriv = await loadAdminPrivateKey();

        // File-based lock to prevent concurrent mint calls from reading the
        // same nonce and producing duplicate events.
        const lockFile = join(ASH_DIR, "mint.lock");
        const lock = await open(lockFile, "wx"); // exclusive create — fails if exists
        let nonce = -1;
        let mintEvt: MintEvent;
        try {
          nonce = await getEventCount(ADMIN_PUBKEY);

          const mintBase = {
            type: "mint" as const,
            nonce,
            timestamp: new Date().toISOString(),
            amount,
            recipient_pubkey: recipientPubkey,
            reason,
            signer_pubkey: ADMIN_PUBKEY,
            signature: "",
          };
          mintEvt = {
            ...mintBase,
            signature: signEd25519(
              canonicalStringify(eventWithoutSignature(mintBase as MintEvent)),
              adminPriv,
            ),
          };

          // Append to admin's own Hypercore.
          await appendEvent(ADMIN_PUBKEY, mintEvt);
        } finally {
          await lock.close();
          await unlink(lockFile).catch(() => {});
        }
        console.log(`\n  ✓  MintEvent appended to admin Hypercore  (nonce: ${nonce})`);

        // Join ledger replication so peers can sync the admin core.
        console.log(`  Replicating to network…`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { default: Hyperswarm } = (await import("hyperswarm")) as any;
        const repSwarm = new Hyperswarm();
        const store = await getCorestore();
        repSwarm.join(LEDGER_TOPIC);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repSwarm.on("connection", (conn: any) => store.replicate(conn));

        await Promise.race([
          repSwarm.flush(),
          new Promise<void>((r) => setTimeout(r, Math.max(opts.wait, 2000))),
        ]);
        await new Promise<void>((r) => setTimeout(r, 2000));

        const peerCount: number = repSwarm.peers.size ?? 0;
        await repSwarm.destroy();
        await closeCorestore();

        console.log(`\n  ✓  ${amount} credits → ${recipientPubkey.slice(0, 16)}…`);
        console.log(`     peers synced: ${peerCount}`);
        console.log(`\n  Recipients will see the balance update on their next 'ash status'.\n`);
      } catch (err) {
        console.error(`\nerror: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }),
);

// ---------------------------------------------------------------------------
// ash admin watch-signups — auto-mint signup bonus for new users
// ---------------------------------------------------------------------------

/** Loads the admin's already-minted recipients (reason == "signup"). */
async function loadMintedSignups(): Promise<Set<string>> {
  const seen = new Set<string>();
  try {
    const events = await getEvents(ADMIN_PUBKEY);
    for (const ev of events) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyEv = ev as any;
      if (anyEv.type === "mint" && anyEv.reason === "signup" && typeof anyEv.recipient_pubkey === "string") {
        seen.add(anyEv.recipient_pubkey);
      }
    }
  } catch { /* empty admin core */ }
  return seen;
}

/**
 * Opens a peer's Hypercore by its published ledger key, waits briefly for
 * replication, and returns true iff it contains a SignupEvent whose
 * `ed25519_public_key` matches `pubkey` AND whose signature verifies against
 * that pubkey. The signature check blocks the "A puts a forged SignupEvent
 * claiming ed25519_public_key=V into A's own core" griefing vector.
 */
export async function peerHasSignupEvent(
  pubkey: string,
  ledgerKeyHex: string,
  timeoutMs = 5000,
): Promise<boolean> {
  let claimedPub;
  try {
    claimedPub = rawHexToPublicKey(pubkey);
  } catch {
    return false;
  }
  try {
    const store = await getCorestore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core: any = store.get(
      Buffer.from(ledgerKeyHex, "hex"),
      { valueEncoding: "utf-8" },
    );
    await core.ready();
    await Promise.race([
      core.update(),
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ]);
    // Cap the scan at the first SIGNUP_SCAN_LIMIT entries. A real
    // SignupEvent is appended in `ash init` BEFORE the user does
    // anything else, so a legitimate user has it within the first
    // handful of blocks. A hostile peer could publish a multi-GB core
    // whose only valid signup sits at index 999_999 to DoS the
    // watcher (memory + bandwidth). Capping here bounds the cost.
    const SIGNUP_SCAN_LIMIT = 64;
    const len: number = Math.min(core.length ?? 0, SIGNUP_SCAN_LIMIT);
    for (let i = 0; i < len; i++) {
      try {
        const raw = await core.get(i) as string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ev = JSON.parse(raw) as any;
        if (ev.type !== "signup" || ev.ed25519_public_key !== pubkey) continue;
        const sigOk = verifyEd25519(
          canonicalStringify(eventWithoutSignature(ev)),
          ev.signature,
          claimedPub,
        );
        if (sigOk) return true;
      } catch { /* skip malformed */ }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Appends a signup MintEvent to the admin's Hypercore under a file lock.
 * The caller must have verified that `recipientPubkey` is eligible.
 */
async function acquireMintLock(lockFile: string): Promise<import("node:fs/promises").FileHandle> {
  // PID-based stale detection: if the lock exists but the writing
  // process is gone, reclaim it. Without this, an admin process
  // killed by SIGKILL leaves the lock file behind and every
  // subsequent mint fails with EEXIST forever.
  try {
    return await open(lockFile, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // Read the existing lock; if it contains a PID we can probe, see
  // if that process is alive.
  let stalePid = 0;
  try {
    const content = (await readFile(lockFile, "utf-8")).trim();
    stalePid = parseInt(content, 10);
  } catch { /* unreadable — treat as stale */ }
  let alive = false;
  if (Number.isFinite(stalePid) && stalePid > 0) {
    try {
      // Signal 0 doesn't deliver a signal — just probes the process.
      process.kill(stalePid, 0);
      alive = true;
    } catch { /* ESRCH or EPERM — treat as not-our-process */ }
  }
  if (alive) {
    throw new Error(
      `mint lock held by pid ${stalePid}. ` +
      `Wait for that process to finish, or remove ${lockFile} manually.`,
    );
  }
  // Stale: replace it.
  await unlink(lockFile).catch(() => {});
  return await open(lockFile, "wx");
}

async function appendSignupMint(
  recipientPubkey: string,
  amount: number,
  adminPriv: KeyObject,
): Promise<void> {
  const lockFile = join(ASH_DIR, "mint.lock");
  const lock = await acquireMintLock(lockFile);
  try {
    // Stamp our PID into the lock so future stale-detection works.
    await lock.write(`${process.pid}\n`, 0);
    await lock.sync().catch(() => {});
    // Re-check inside the lock: another process may have minted concurrently.
    const existing = await getEvents(ADMIN_PUBKEY);
    for (const ev of existing) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyEv = ev as any;
      if (
        anyEv.type === "mint" &&
        anyEv.reason === "signup" &&
        anyEv.recipient_pubkey === recipientPubkey
      ) return;
    }
    const nonce = await getEventCount(ADMIN_PUBKEY);
    const base = {
      type: "mint" as const,
      nonce,
      timestamp: new Date().toISOString(),
      amount,
      recipient_pubkey: recipientPubkey,
      reason: "signup",
      signer_pubkey: ADMIN_PUBKEY,
      signature: "",
    };
    const mint: MintEvent = {
      ...base,
      signature: signEd25519(
        canonicalStringify(eventWithoutSignature(base as MintEvent)),
        adminPriv,
      ),
    };
    await appendEvent(ADMIN_PUBKEY, mint as Event);
  } finally {
    await lock.close();
    await unlink(lockFile).catch(() => {});
  }
}

adminCommand.addCommand(
  new Command("watch-signups")
    .description("Auto-mint signup bonus for new peers joining the network")
    .option("--bonus <n>", "Override per-user signup bonus", parseInt)
    .action(async (opts: { bonus?: number }) => {
      if (!ADMIN_PUBKEY) {
        console.error("\nerror: ADMIN_PUBKEY is not set in shared/constants.ts\n");
        process.exit(1);
      }
      const bonus = opts.bonus ?? SIGNUP_BONUS;
      if (!Number.isFinite(bonus) || bonus <= 0) {
        console.error("\nerror: bonus must be a positive integer\n");
        process.exit(1);
      }

      let adminPriv: KeyObject;
      try {
        adminPriv = await loadAdminPrivateKey();
      } catch (err) {
        console.error(`\nerror: ${(err as Error).message}\n`);
        process.exit(1);
      }

      const minted = await loadMintedSignups();
      const inFlight = new Set<string>();
      console.log(
        `\n  ash admin watch-signups` +
        `\n  bonus:        ${bonus}cr` +
        `\n  already sent: ${minted.size}` +
        `\n  Press Ctrl+C to stop.\n`,
      );

      const swarm = new AshSwarm();
      // Register the handler BEFORE join so we don't drop peer:info messages
      // from peers that connect during the swarm's discovery ramp-up. The
      // handshake-verified identity (_peer.pubkey) is used as the mint target
      // — msg.pubkey is self-declared and cannot be trusted on its own.
      swarm.onMessage(async (peer, msg) => {
        if (msg.type !== "peer:info") return;
        const pubkey = peer.pubkey;
        const ledgerKey = msg.ledger_core_key;
        if (!ledgerKey) return;
        if (pubkey === ADMIN_PUBKEY) return;
        if (minted.has(pubkey) || inFlight.has(pubkey)) return;
        inFlight.add(pubkey);
        try {
          const hasSignup = await peerHasSignupEvent(pubkey, ledgerKey);
          if (!hasSignup) return;
          await appendSignupMint(pubkey, bonus, adminPriv);
          minted.add(pubkey);
          console.log(`  +${bonus}cr  →  ${pubkey.slice(0, 16)}…  (${msg.username ?? "—"})`);
        } catch (err) {
          console.warn(`  ⚠  ${pubkey.slice(0, 8)}: ${(err as Error).message}`);
        } finally {
          inFlight.delete(pubkey);
        }
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let repSwarm: any = null;
      try {
        await swarm.join(adminPriv, ADMIN_PUBKEY);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { default: Hyperswarm } = (await import("hyperswarm")) as any;
        repSwarm = new Hyperswarm();
        const store = await getCorestore();
        repSwarm.join(LEDGER_TOPIC);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repSwarm.on("connection", (conn: any) => store.replicate(conn));
      } catch (err) {
        console.error(`\n  Failed to join network: ${(err as Error).message}\n`);
        await swarm.destroy().catch(() => {});
        process.exit(1);
      }

      const shutdown = async (): Promise<void> => {
        console.log("\n  shutting down…");
        await repSwarm?.destroy().catch(() => {});
        await swarm.destroy().catch(() => {});
        await closeCorestore().catch(() => {});
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Keep the process alive; work happens in onMessage callbacks.
      await new Promise<void>(() => {});
    }),
);
