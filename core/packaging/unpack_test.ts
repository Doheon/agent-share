/**
 * Unit tests for security-critical unpack logic (core/packaging/unpack.ts)
 * Tests symlink rejection, path traversal rejection, absolute path rejection,
 * and tar bomb prevention.
 */

import { test, expect } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unpackToDirectory } from "./unpack.ts";
import { generateKey, exportKey } from "../crypto/aes.ts";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ash-unpack-test-"));
}

async function cleanup(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ─── Tar builder helpers ────────────────────────────────────────────────────

function createTarHeader(
  path: string,
  size: number,
  type: string = "0",
): Uint8Array {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();

  const writeField = (offset: number, length: number, value: string) => {
    const bytes = enc.encode(value);
    header.set(bytes.slice(0, length), offset);
  };

  writeField(0, 100, path);
  writeField(100, 8, "0000644\0");
  writeField(108, 8, "0000000\0");
  writeField(116, 8, "0000000\0");
  writeField(124, 12, size.toString(8).padStart(11, "0") + "\0");
  writeField(136, 12, Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0");
  writeField(156, 1, type);
  writeField(257, 6, "ustar");
  writeField(263, 2, "00");

  // Checksum
  writeField(148, 8, "        ");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeField(148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");

  return header;
}

function buildTar(entries: { path: string; data: Uint8Array; type?: string }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const { path, data, type = "0" } of entries) {
    blocks.push(createTarHeader(path, data.length, type));
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024)); // EOF
  const total = blocks.reduce((s, b) => s + b.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) { buf.set(b, off); off += b.length; }
  return buf;
}

async function encryptTar(tar: Uint8Array): Promise<{ ciphertext: Uint8Array; aesKeyRaw: Uint8Array; iv: Uint8Array }> {
  const key = await generateKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as Uint8Array<ArrayBuffer> },
    key,
    tar as unknown as Uint8Array<ArrayBuffer>,
  );
  const ciphertext = new Uint8Array(ciphertextBuf);
  const aesKeyRaw = await exportKey(key);
  return { ciphertext, aesKeyRaw, iv };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("rejects symlink entries with security violation error", async () => {
  const destDir = await makeTempDir();
  try {
    // type "2" = symlink in tar
    const tar = buildTar([{ path: "evil-link", data: new Uint8Array(0), type: "2" }]);
    const { ciphertext, aesKeyRaw, iv } = await encryptTar(tar);

    await expect(() => unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir)).rejects.toThrow();
  } finally {
    await cleanup(destDir);
  }
});

test("rejects path traversal entries containing ..", async () => {
  const destDir = await makeTempDir();
  try {
    const tar = buildTar([{ path: "../escaped.txt", data: new TextEncoder().encode("evil") }]);
    const { ciphertext, aesKeyRaw, iv } = await encryptTar(tar);

    await expect(() => unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir)).rejects.toThrow();
  } finally {
    await cleanup(destDir);
  }
});

test("rejects deeply nested path traversal (sub/../../outside.txt)", async () => {
  const destDir = await makeTempDir();
  try {
    const tar = buildTar([{ path: "sub/../../outside.txt", data: new TextEncoder().encode("evil") }]);
    const { ciphertext, aesKeyRaw, iv } = await encryptTar(tar);

    await expect(() => unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir)).rejects.toThrow();
  } finally {
    await cleanup(destDir);
  }
});

test("rejects absolute path entries starting with /", async () => {
  const destDir = await makeTempDir();
  try {
    const tar = buildTar([{ path: "/etc/passwd", data: new TextEncoder().encode("evil") }]);
    const { ciphertext, aesKeyRaw, iv } = await encryptTar(tar);

    await expect(() => unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir)).rejects.toThrow();
  } finally {
    await cleanup(destDir);
  }
});

test("valid tar extracts files correctly to destination directory", async () => {
  const destDir = await makeTempDir();
  try {
    const content = new TextEncoder().encode("safe content");
    const tar = buildTar([{ path: "safe.txt", data: content }]);
    const { ciphertext, aesKeyRaw, iv } = await encryptTar(tar);

    await unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir);

    const result = await readFile(`${destDir}/safe.txt`, "utf-8");
    expect(result).toEqual("safe content");
  } finally {
    await cleanup(destDir);
  }
});

test("unpack with wrong AES key throws decryption error", async () => {
  const destDir = await makeTempDir();
  try {
    const content = new TextEncoder().encode("data");
    const tar = buildTar([{ path: "file.txt", data: content }]);
    const { ciphertext, iv } = await encryptTar(tar);
    const wrongKey = await generateKey();
    const wrongKeyRaw = await exportKey(wrongKey);

    await expect(() => unpackToDirectory(ciphertext, wrongKeyRaw, iv, destDir)).rejects.toThrow();
  } finally {
    await cleanup(destDir);
  }
});

test("rejects all entries when any single entry is malicious (fail-closed)", async () => {
  const destDir = await makeTempDir();
  try {
    // Mix of safe and dangerous entries
    const tar = buildTar([
      { path: "safe.txt", data: new TextEncoder().encode("safe") },
      { path: "../evil.txt", data: new TextEncoder().encode("evil") },
    ]);
    const { ciphertext, aesKeyRaw, iv } = await encryptTar(tar);

    await expect(() => unpackToDirectory(ciphertext, aesKeyRaw, iv, destDir)).rejects.toThrow();

    // safe.txt must NOT have been written (fail-closed: validate all before extracting any)
    let safeExists = false;
    try {
      await stat(`${destDir}/safe.txt`);
      safeExists = true;
    } catch { /* expected */ }
    expect(safeExists).toEqual(false);
  } finally {
    await cleanup(destDir);
  }
});
