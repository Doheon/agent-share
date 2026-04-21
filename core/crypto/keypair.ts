import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  exportPrivateKeyPem,
  exportPublicKeyPem,
  generateKeyPair,
  importPrivateKeyPem,
  importPublicKeyPem,
  type RsaKeyPair,
} from "./rsa.ts";

const KEYS_DIR = join(homedir(), ".agent-share", "keys");

function keyPath(userId: string): string {
  return join(KEYS_DIR, `${userId}.pem`);
}

function pubKeyPath(userId: string): string {
  return join(KEYS_DIR, `${userId}.pub.pem`);
}

export async function hasKeyPair(userId: string): Promise<boolean> {
  try {
    await stat(keyPath(userId));
    return true;
  } catch {
    return false;
  }
}

export async function createKeyPair(userId: string): Promise<RsaKeyPair> {
  await mkdir(KEYS_DIR, { recursive: true });

  const pair = await generateKeyPair();
  const privatePem = await exportPrivateKeyPem(pair.privateKey);
  const publicPem = await exportPublicKeyPem(pair.publicKey);

  await writeFile(keyPath(userId), privatePem, { mode: 0o600 });
  await writeFile(pubKeyPath(userId), publicPem, { mode: 0o644 });

  return pair;
}

export async function loadPrivateKey(userId: string): Promise<CryptoKey> {
  let pem: string;
  try {
    pem = await readFile(keyPath(userId), "utf-8");
  } catch {
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
