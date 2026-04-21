import { readFile } from "node:fs/promises";
import { walk } from "../util/walk.ts";
import { encryptData, exportKey } from "../crypto/aes.ts";
import { loadGitignorePatterns } from "../util/gitignore.ts";

const MAX_BLOB_SIZE = 45 * 1024 * 1024;     // 45MB — conservative limit for P2P blob transfer
const LARGE_FILE_WARN = 5 * 1024 * 1024;    // individual files >=5MB get reported on error

function isIgnored(relPath: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(relPath));
}

// Built-in ignore list — applied even when .gitignore is missing. Covers
// obvious never-upload items (vcs metadata, dependency trees, OS junk, and
// the ash binary itself which is 60+MB).
const ALWAYS_IGNORE: RegExp[] = [
  /^\.git\//,
  /^node_modules\//,
  /(^|\/)\.DS_Store$/,
  /^\.env/,
  /^ash$/,
  /^ash-[^/]*$/,
  /\.(exe|dll|dmg|pkg|deb|rpm|iso|img)$/i,
];

interface PackedTar {
  tar: Uint8Array;
  largest: { path: string; size: number }[];
}

async function directoryToTar(dir: string): Promise<PackedTar> {
  const ignorePatterns = await loadGitignorePatterns(dir);
  const entries: { path: string; data: Uint8Array }[] = [];
  const fileSizes: { path: string; size: number }[] = [];

  for await (const entry of walk(dir)) {
    if (!entry.isFile) continue;

    const relPath = entry.path.slice(dir.length + 1);

    if (ALWAYS_IGNORE.some((p) => p.test(relPath))) continue;
    if (isIgnored(relPath, ignorePatterns)) continue;

    const data = await readFile(entry.path);
    const bytes = new Uint8Array(data);
    entries.push({ path: relPath, data: bytes });
    fileSizes.push({ path: relPath, size: bytes.length });
  }

  const largest = fileSizes
    .filter((f) => f.size >= LARGE_FILE_WARN)
    .sort((a, b) => b.size - a.size)
    .slice(0, 5);

  return { tar: buildTar(entries), largest };
}

function buildTar(entries: { path: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = [];

  for (const { path, data } of entries) {
    const header = createTarHeader(path, data.length);
    blocks.push(header);

    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }

  blocks.push(new Uint8Array(1024));

  const total = blocks.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }
  return result;
}

function createTarHeader(path: string, size: number): Uint8Array {
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
  writeField(156, 1, "0");
  writeField(257, 6, "ustar");
  writeField(263, 2, "00");

  writeField(148, 8, "        ");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeField(148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");

  return header;
}

export interface PackResult {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  aesKeyRaw: Uint8Array;
}

export class PackageTooLargeError extends Error {
  constructor(
    public sizeMB: number,
    public limitMB: number,
    public largest: { path: string; size: number }[],
  ) {
    const lines = [
      `Package is ${sizeMB.toFixed(1)}MB — exceeds the ${limitMB}MB upload limit.`,
    ];
    if (largest.length) {
      lines.push("Largest files included:");
      for (const f of largest) {
        lines.push(`  • ${(f.size / 1024 / 1024).toFixed(1).padStart(5)}MB  ${f.path}`);
      }
      lines.push("Add these to .gitignore (or run ash from a smaller project directory) and try again.");
    }
    super(lines.join("\n"));
    this.name = "PackageTooLargeError";
  }
}

export async function packDirectory(dir: string): Promise<PackResult> {
  const { tar, largest } = await directoryToTar(dir);

  if (tar.length > MAX_BLOB_SIZE) {
    throw new PackageTooLargeError(
      tar.length / 1024 / 1024,
      MAX_BLOB_SIZE / 1024 / 1024,
      largest,
    );
  }

  const { ciphertext, key, iv } = await encryptData(tar);
  const aesKeyRaw = await exportKey(key);

  return { ciphertext, iv, aesKeyRaw };
}
