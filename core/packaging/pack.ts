/**
 * 디렉토리 → 암호화된 tar 아카이브 패키징
 * - .gitignore 규칙 준수
 * - AES-256-GCM 암호화 적용
 */

import { join } from "@std/path";
import { walk } from "@std/fs";
import { encryptData, exportKey } from "../crypto/aes.ts";

const MAX_BLOB_SIZE = 100 * 1024 * 1024; // 100MB

/** .gitignore 패턴을 간단하게 파싱 */
async function loadGitignorePatterns(dir: string): Promise<RegExp[]> {
  const patterns: RegExp[] = [];
  try {
    const content = await Deno.readTextFile(join(dir, ".gitignore"));
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      // 간단한 glob → regex 변환
      const regexStr = trimmed
        .replace(/\./g, "\\.")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
      patterns.push(new RegExp(`(^|/)${regexStr}(/|$)`));
    }
  } catch {
    // .gitignore 없으면 무시
  }
  return patterns;
}

function isIgnored(relPath: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(relPath));
}

/** 디렉토리를 tar 바이너리로 변환 */
async function directoryToTar(dir: string): Promise<Uint8Array> {
  const ignorePatterns = await loadGitignorePatterns(dir);

  // 항상 제외할 패턴
  const alwaysIgnore = [
    /^\.git\//,
    /^node_modules\//,
    /^\.env/,
  ];

  const entries: { path: string; data: Uint8Array }[] = [];

  for await (const entry of walk(dir, { followSymlinks: false })) {
    if (!entry.isFile) continue;

    const relPath = entry.path.slice(dir.length + 1);

    if (alwaysIgnore.some((p) => p.test(relPath))) continue;
    if (isIgnored(relPath, ignorePatterns)) continue;

    const data = await Deno.readFile(entry.path);
    entries.push({ path: relPath, data });
  }

  return buildTar(entries);
}

/** 간단한 tar 빌더 (ustar 포맷) */
function buildTar(entries: { path: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = [];

  for (const { path, data } of entries) {
    const header = createTarHeader(path, data.length);
    blocks.push(header);

    // 데이터를 512바이트 블록으로 패딩
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }

  // EOF: 2개의 빈 512바이트 블록
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

  writeField(0, 100, path);           // filename
  writeField(100, 8, "0000644\0");    // file mode
  writeField(108, 8, "0000000\0");    // uid
  writeField(116, 8, "0000000\0");    // gid
  writeField(124, 12, size.toString(8).padStart(11, "0") + "\0"); // size (octal)
  writeField(136, 12, Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0"); // mtime
  writeField(156, 1, "0");            // type: regular file
  writeField(257, 6, "ustar");        // magic
  writeField(263, 2, "00");           // version

  // checksum 계산
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

export async function packDirectory(dir: string): Promise<PackResult> {
  const tar = await directoryToTar(dir);

  if (tar.length > MAX_BLOB_SIZE) {
    throw new Error(
      `패키지 크기가 너무 큽니다: ${(tar.length / 1024 / 1024).toFixed(1)}MB (최대 100MB)`,
    );
  }

  const { ciphertext, key, iv } = await encryptData(tar);
  const aesKeyRaw = await exportKey(key);

  return { ciphertext, iv, aesKeyRaw };
}
