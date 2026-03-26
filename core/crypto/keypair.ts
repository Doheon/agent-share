/**
 * 로컬 RSA 키쌍 관리
 * 개인키: ~/.agent-share/keys/<user_id>.pem (mode 600)
 * 공개키: Supabase DB users.public_key 에 등록
 */

import { join } from "@std/path";
import {
  exportPrivateKeyPem,
  exportPublicKeyPem,
  generateKeyPair,
  importPrivateKeyPem,
  importPublicKeyPem,
  type RsaKeyPair,
} from "./rsa.ts";

const KEYS_DIR = join(Deno.env.get("HOME") ?? "~", ".agent-share", "keys");

function keyPath(userId: string): string {
  return join(KEYS_DIR, `${userId}.pem`);
}

function pubKeyPath(userId: string): string {
  return join(KEYS_DIR, `${userId}.pub.pem`);
}

/** 키쌍이 로컬에 존재하는지 확인 */
export async function hasKeyPair(userId: string): Promise<boolean> {
  try {
    await Deno.stat(keyPath(userId));
    return true;
  } catch {
    return false;
  }
}

/** 새 키쌍 생성 및 저장 */
export async function createKeyPair(userId: string): Promise<RsaKeyPair> {
  await Deno.mkdir(KEYS_DIR, { recursive: true });

  const pair = await generateKeyPair();
  const privatePem = await exportPrivateKeyPem(pair.privateKey);
  const publicPem = await exportPublicKeyPem(pair.publicKey);

  // 개인키 저장 (mode 600)
  await Deno.writeTextFile(keyPath(userId), privatePem, { mode: 0o600 });
  // 공개키 저장 (참조용)
  await Deno.writeTextFile(pubKeyPath(userId), publicPem, { mode: 0o644 });

  return pair;
}

/** 로컬 개인키 불러오기 */
export async function loadPrivateKey(userId: string): Promise<CryptoKey> {
  let pem: string;
  try {
    pem = await Deno.readTextFile(keyPath(userId));
  } catch {
    throw new Error(
      `개인키를 찾을 수 없습니다: ${keyPath(userId)}\n` +
        `ash setup 을 먼저 실행해주세요.`,
    );
  }
  return await importPrivateKeyPem(pem);
}

/** 로컬 공개키 PEM 불러오기 */
export async function loadPublicKeyPem(userId: string): Promise<string> {
  try {
    return await Deno.readTextFile(pubKeyPath(userId));
  } catch {
    throw new Error(
      `공개키를 찾을 수 없습니다: ${pubKeyPath(userId)}\n` +
        `ash setup 을 먼저 실행해주세요.`,
    );
  }
}

/** 키쌍 로드 또는 생성 */
export async function getOrCreateKeyPair(userId: string): Promise<RsaKeyPair> {
  if (await hasKeyPair(userId)) {
    const pem = await Deno.readTextFile(keyPath(userId));
    const pubPem = await Deno.readTextFile(pubKeyPath(userId));
    return {
      privateKey: await importPrivateKeyPem(pem),
      publicKey: await importPublicKeyPem(pubPem),
    };
  }
  return await createKeyPair(userId);
}
