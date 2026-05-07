import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { walk } from "./walk.ts";

// Directories that never contain useful .gitignore files — skip descending into them.
const NEVER_DESCEND = [/^\.git$/, /^node_modules$/, /^\.omc$/, /^\.claude$/];

/**
 * Converts raw .gitignore lines to RegExp matchers anchored under `prefix`.
 *
 * Limitations vs full gitignore semantics:
 *   - `!negation` lines are skipped.
 *   - `**` is approximated by `.*`.
 *   - Trailing-slash directory-only matching is stripped (not enforced).
 */
function linesToPatterns(lines: string[], prefix = ""): RegExp[] {
  const escapedPrefix = prefix
    ? prefix.replace(/[.+^${}()|[\]\\]/g, "\\$&") + "/"
    : "";
  return lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((pattern) => {
      const clean = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
      const escaped = clean
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return new RegExp(`(^|/)${escapedPrefix}${escaped}(/|$)`);
    });
}

/** Loads only the root-level `.gitignore`. */
export async function loadGitignorePatterns(dir: string): Promise<RegExp[]> {
  try {
    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    return linesToPatterns(content.split("\n"));
  } catch {
    return [];
  }
}

/**
 * Loads `.gitignore` files from `rootDir` and all subdirectories.
 * Patterns from subdirectory gitignores are anchored to their directory so
 * `project1/.gitignore` with `venv/` excludes `project1/venv/...` but not
 * `project2/venv/...`.
 */
export async function loadAllGitignorePatterns(rootDir: string): Promise<RegExp[]> {
  const all: RegExp[] = await loadGitignorePatterns(rootDir);

  for await (const entry of walk(rootDir)) {
    if (!entry.isFile || entry.name !== ".gitignore") continue;

    const relPath = entry.path.slice(rootDir.length + 1);
    if (relPath === ".gitignore") continue; // root already loaded above

    const dirRel = relPath.slice(0, -(entry.name.length + 1)); // e.g. "project1"
    if (dirRel.split("/").some((seg) => NEVER_DESCEND.some((p) => p.test(seg)))) continue;

    try {
      const content = await readFile(entry.path, "utf-8");
      all.push(...linesToPatterns(content.split("\n"), dirRel));
    } catch { /* skip unreadable */ }
  }

  return all;
}
