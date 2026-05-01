import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface WalkEntry {
  path: string;
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * Recursively yields entries under `dir`. Unreadable directories
 * (EACCES, EPERM) are skipped silently rather than aborting the whole
 * walk — packing a project should never crash because one subtree is
 * locked down by the OS (e.g. mounted Windows volumes under WSL,
 * checked-out submodules with foreign permissions).
 *
 * Symlinks: `readdir` reports them as `Symlink` entries. We do not
 * recurse into symlinked directories, which prevents accidental loops
 * and keeps the pack size predictable.
 */
export async function* walk(dir: string): AsyncGenerator<WalkEntry> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    yield { path, name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() };
    if (e.isDirectory()) yield* walk(path);
  }
}
