import { dirname, join, normalize } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { decryptData, importKey } from "../crypto/aes.ts";
import { MAX_BLOB_SIZE } from "../../shared/protocol.ts";

const MAX_EXTRACT_SIZE = MAX_BLOB_SIZE;

interface TarEntry {
  path: string;
  size: number;
  type: string;
  data: Uint8Array;
}

function parseTar(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  const dec = new TextDecoder();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.slice(offset, offset + 512);

    if (header.every((b) => b === 0)) break;

    const path    = dec.decode(header.slice(0, 100)).replace(/\0/g, "");
    const sizeStr = dec.decode(header.slice(124, 136)).replace(/\0/g, "").trim();
    const size    = parseInt(sizeStr, 8) || 0;
    const type    = dec.decode(header.slice(156, 157)).replace(/\0/g, "") || "0";

    offset += 512;
    const data = tar.slice(offset, offset + size);
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;

    if (path) entries.push({ path, size, type, data });
  }

  return entries;
}

function validateEntry(entry: TarEntry, destDir: string): void {
  if (entry.type === "1" || entry.type === "2") {
    throw new Error(`Blocked: TAR entry type ${entry.type} (hardlinks and symlinks not allowed)`);
  }
  if (entry.path.includes("..")) {
    throw new Error(`Security violation: path traversal attempt detected: ${entry.path}`);
  }
  if (entry.path.startsWith("/")) {
    throw new Error(`Security violation: absolute path detected: ${entry.path}`);
  }
  const resolved = normalize(join(destDir, entry.path));
  if (!resolved.startsWith(normalize(destDir))) {
    throw new Error(`Security violation: path escapes destination directory: ${entry.path}`);
  }
}

export async function unpackToDirectory(
  ciphertext: Uint8Array,
  aesKeyRaw: Uint8Array,
  iv: Uint8Array,
  destDir: string,
): Promise<void> {
  const key = await importKey(aesKeyRaw);
  const tar = await decryptData(ciphertext, key, iv);

  if (tar.length > MAX_EXTRACT_SIZE) {
    throw new Error(
      `Extracted size exceeds limit: ${(tar.length / 1024 / 1024).toFixed(1)}MB (max 500MB)`,
    );
  }

  const entries = parseTar(tar);

  for (const entry of entries) {
    validateEntry(entry, destDir);
  }

  await mkdir(destDir, { recursive: true });

  for (const entry of entries) {
    if (entry.type === "5") {
      await mkdir(join(destDir, entry.path), { recursive: true });
      continue;
    }
    const filePath = join(destDir, entry.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, entry.data);
  }
}
