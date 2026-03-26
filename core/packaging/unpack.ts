/**
 * 암호화된 tar 아카이브 → 디렉토리 언팩
 * 보안:
 *   - symlink 엔트리 즉시 거부
 *   - path traversal (../) 즉시 거부
 *   - 압축 비율 검증 (tar bomb 방지)
 */

import { dirname, join, normalize } from "@std/path";
import { ensureDir } from "@std/fs";
import { decryptData, importKey } from "../crypto/aes.ts";

const MAX_EXTRACT_SIZE = 500 * 1024 * 1024; // 500MB (압축 후 최대)

interface TarEntry {
  path: string;
  size: number;
  type: string; // "0"=file, "2"=symlink, "5"=dir
  data: Uint8Array;
}

function parseTar(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  const dec = new TextDecoder();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.slice(offset, offset + 512);

    // EOF 블록 확인
    if (header.every((b) => b === 0)) break;

    const path = dec.decode(header.slice(0, 100)).replace(/\0/g, "");
    const sizeStr = dec.decode(header.slice(124, 136)).replace(/\0/g, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = dec.decode(header.slice(156, 157)).replace(/\0/g, "") || "0";

    offset += 512;
    const data = tar.slice(offset, offset + size);
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;

    if (path) entries.push({ path, size, type, data });
  }

  return entries;
}

function validateEntry(entry: TarEntry, destDir: string): void {
  // symlink 차단
  if (entry.type === "2") {
    throw new Error(`보안 위반: symlink 엔트리가 포함되어 있습니다: ${entry.path}`);
  }

  // path traversal 차단
  if (entry.path.includes("..")) {
    throw new Error(`보안 위반: path traversal 시도가 감지되었습니다: ${entry.path}`);
  }

  // 절대 경로 차단
  if (entry.path.startsWith("/")) {
    throw new Error(`보안 위반: 절대 경로가 포함되어 있습니다: ${entry.path}`);
  }

  // 정규화 후 destDir 밖으로 나가는지 확인
  const resolved = normalize(join(destDir, entry.path));
  if (!resolved.startsWith(normalize(destDir))) {
    throw new Error(`보안 위반: 대상 디렉토리 밖 경로입니다: ${entry.path}`);
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

  // tar bomb 방지: 압축 해제 크기 제한
  if (tar.length > MAX_EXTRACT_SIZE) {
    throw new Error(
      `압축 해제 크기 초과: ${(tar.length / 1024 / 1024).toFixed(1)}MB (최대 500MB)`,
    );
  }

  const entries = parseTar(tar);

  // 모든 엔트리 검증 먼저 (일부 언팩 후 차단 방지)
  for (const entry of entries) {
    validateEntry(entry, destDir);
  }

  // 검증 통과 후 언팩
  await ensureDir(destDir);

  for (const entry of entries) {
    if (entry.type === "5") {
      // 디렉토리
      await ensureDir(join(destDir, entry.path));
      continue;
    }

    const filePath = join(destDir, entry.path);
    await ensureDir(dirname(filePath));
    await Deno.writeFile(filePath, entry.data);
  }
}
