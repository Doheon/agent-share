/**
 * AES-256-GCM encryption/decryption
 * Uses Web Crypto API (crypto.subtle) — no external dependencies.
 * A fresh AES key is generated per task (single-use).
 */

const AES_ALGORITHM = "AES-GCM";
const AES_KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96-bit IV recommended for GCM

export async function generateKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey(
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
    true, // extractable
    ["encrypt", "decrypt"],
  );
}

export async function encryptData(
  data: Uint8Array,
): Promise<{ ciphertext: Uint8Array; key: CryptoKey; iv: Uint8Array }> {
  const key = await generateKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: AES_ALGORITHM, iv: iv as unknown as Uint8Array<ArrayBuffer> },
    key,
    data as unknown as Uint8Array<ArrayBuffer>,
  );

  return {
    ciphertext: new Uint8Array(ciphertextBuffer),
    key,
    iv,
  };
}

export async function decryptData(
  ciphertext: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: AES_ALGORITHM, iv: iv as unknown as Uint8Array<ArrayBuffer> },
    key,
    ciphertext as unknown as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(plaintextBuffer);
}

export async function exportKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

export async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    raw as unknown as Uint8Array<ArrayBuffer>,
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
    true,
    ["encrypt", "decrypt"],
  );
}
