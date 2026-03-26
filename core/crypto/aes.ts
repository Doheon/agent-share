/**
 * AES-256-GCM 암복호화 모듈
 * Web Crypto API (crypto.subtle) 사용 — 외부 라이브러리 의존 없음
 * AES 키는 작업당 1회 생성 (일회용)
 */

const AES_ALGORITHM = "AES-GCM";
const AES_KEY_LENGTH = 256;
const IV_LENGTH = 12; // GCM 권장 96-bit IV

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
    { name: AES_ALGORITHM, iv },
    key,
    data,
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
    { name: AES_ALGORITHM, iv },
    key,
    ciphertext,
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
    raw,
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
    true,
    ["encrypt", "decrypt"],
  );
}
