import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import {
  exportPrivateKeyPem,
  exportPublicKeyPem,
  generateKeyPair,
  importPrivateKeyPem,
  importPublicKeyPem,
  type RsaKeyPair,
} from "./rsa.ts";
import { ASH_DIR } from "../../cli/ash_dir.ts";

// RSA-OAEP keys live alongside the rest of identity state under
// ASH_DIR/keys/rsa. Earlier builds wrote them to ~/.agent-share/keys —
// existing files are migrated on first read so users do not lose access
// after upgrading.
const KEYS_DIR = join(ASH_DIR, "keys", "rsa");
const LEGACY_KEYS_DIR = join(homedir(), ".agent-share", "keys");

function keyPath(userId: string): string {
  return join(KEYS_DIR, `${userId}.pem`);
}

function pubKeyPath(userId: string): string {
  return join(KEYS_DIR, `${userId}.pub.pem`);
}

function legacyKeyPath(userId: string): string {
  return join(LEGACY_KEYS_DIR, `${userId}.pem`);
}

function legacyPubKeyPath(userId: string): string {
  return join(LEGACY_KEYS_DIR, `${userId}.pub.pem`);
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function migrateLegacyIfPresent(userId: string): Promise<boolean> {
  const legacyPriv = legacyKeyPath(userId);
  if (!(await exists(legacyPriv))) return false;
  const legacyPub = legacyPubKeyPath(userId);
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 });
  // rename is atomic when src/dst share a filesystem (the typical case
  // when both are under $HOME). On cross-FS or permission failure we
  // surface a warning rather than silently dropping the legacy key —
  // the caller would otherwise see a misleading "key not found" error
  // and start fresh, abandoning the user's existing identity.
  try {
    await rename(legacyPriv, keyPath(userId));
  } catch (err) {
    console.error(
      `[ash] could not migrate legacy RSA key from ${legacyPriv}: ` +
      `${(err as Error).message}\n` +
      `       Move the file manually:  mv ${legacyPriv} ${keyPath(userId)}`,
    );
    return false;
  }
  if (await exists(legacyPub)) {
    try { await rename(legacyPub, pubKeyPath(userId)); } catch { /* non-fatal */ }
  }
  return true;
}

export async function hasKeyPair(userId: string): Promise<boolean> {
  if (await exists(keyPath(userId))) return true;
  return migrateLegacyIfPresent(userId);
}

export async function createKeyPair(userId: string): Promise<RsaKeyPair> {
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 });

  const pair = await generateKeyPair();
  const privatePem = await exportPrivateKeyPem(pair.privateKey);
  const publicPem = await exportPublicKeyPem(pair.publicKey);

  await writeFile(keyPath(userId), privatePem, { mode: 0o600 });
  await writeFile(pubKeyPath(userId), publicPem, { mode: 0o644 });

  return pair;
}

export async function loadPrivateKey(userId: string): Promise<CryptoKey> {
  // Pull the file from the legacy path on first run after upgrade.
  // The migrate function logs to stderr on failure; we use its return
  // value to decide which error to surface so the user gets the right
  // recovery instructions (don't tell them to "run ash setup" if a
  // legacy key still exists at ~/.agent-share/keys — that would
  // discard their identity).
  let migrationFailed = false;
  if (!(await exists(keyPath(userId)))) {
    if (await exists(legacyKeyPath(userId))) {
      const migrated = await migrateLegacyIfPresent(userId);
      if (!migrated) migrationFailed = true;
    }
  }
  let pem: string;
  try {
    pem = await readFile(keyPath(userId), "utf-8");
  } catch {
    if (migrationFailed) {
      throw new Error(
        `Private key not loaded: legacy migration to ${keyPath(userId)} failed.\n` +
        `  See the warning above. Move the file manually before retrying.\n` +
        `  Do NOT run \`ash setup\` — it will create a new keypair and abandon your existing identity.`,
      );
    }
    throw new Error(
      `Private key not found: ${keyPath(userId)}\nPlease run ash setup first.`,
    );
  }
  return await importPrivateKeyPem(pem);
}

export async function getOrCreateKeyPair(userId: string): Promise<RsaKeyPair> {
  if (await hasKeyPair(userId)) {
    const pem    = await readFile(keyPath(userId), "utf-8");
    const pubPem = await readFile(pubKeyPath(userId), "utf-8");
    return {
      privateKey: await importPrivateKeyPem(pem),
      publicKey:  await importPublicKeyPem(pubPem),
    };
  }
  return await createKeyPair(userId);
}
