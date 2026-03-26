/**
 * RSA-OAEP 키 생성 및 AES 키 교환 모듈
 * 수락자의 공개키로 AES 키를 암호화하여 안전하게 전달
 */

const RSA_ALGORITHM = "RSA-OAEP";
const RSA_KEY_LENGTH = 2048;
const RSA_HASH = "SHA-256";

export interface RsaKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export async function generateKeyPair(): Promise<RsaKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: RSA_ALGORITHM,
      modulusLength: RSA_KEY_LENGTH,
      publicExponent: new Uint8Array([1, 0, 1]), // 65537
      hash: RSA_HASH,
    },
    true,
    ["encrypt", "decrypt"],
  );
  return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey };
}

/** 공개키를 PEM 형식으로 내보내기 */
export async function exportPublicKeyPem(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

/** 개인키를 PEM 형식으로 내보내기 */
export async function exportPrivateKeyPem(privateKey: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

/** PEM 형식 공개키 가져오기 */
export async function importPublicKeyPem(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s/g, "");
  const binary = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "spki",
    binary,
    { name: RSA_ALGORITHM, hash: RSA_HASH },
    true,
    ["encrypt"],
  );
}

/** PEM 형식 개인키 가져오기 */
export async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: RSA_ALGORITHM, hash: RSA_HASH },
    true,
    ["decrypt"],
  );
}

/** AES 키를 수락자 공개키로 암호화 → base64 반환 */
export async function encryptAesKey(
  aesKeyRaw: Uint8Array,
  recipientPublicKey: CryptoKey,
): Promise<string> {
  const encrypted = await crypto.subtle.encrypt(
    { name: RSA_ALGORITHM },
    recipientPublicKey,
    aesKeyRaw,
  );
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

/** base64 암호화된 AES 키를 개인키로 복호화 */
export async function decryptAesKey(
  encryptedKeyB64: string,
  privateKey: CryptoKey,
): Promise<Uint8Array> {
  const encrypted = Uint8Array.from(atob(encryptedKeyB64), (c) => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt(
    { name: RSA_ALGORITHM },
    privateKey,
    encrypted,
  );
  return new Uint8Array(decrypted);
}
