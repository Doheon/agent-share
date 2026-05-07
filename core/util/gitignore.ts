import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { walk } from "./walk.ts";

// Directories that never contain useful .gitignore files — skip descending into them.
const NEVER_DESCEND = [/^\.git$/, /^node_modules$/, /^\.omc$/, /^\.claude$/];

/**
 * Converts raw .gitignore lines to RegExp matchers anchored under `prefix`.
 *
 * Follows git gitignore semantics:
 *   - `!negation` lines are skipped.
 *   - Leading `/` anchors the pattern to the gitignore's own directory.
 *   - An interior `/` (e.g. `src/foo`) also anchors the pattern.
 *   - Patterns without any `/` match at any depth within the prefix subtree.
 *   - `*` matches any characters except `/` (does not cross directory boundaries).
 *   - `**` matches across directory boundaries.
 *   - `?` matches any single character except `/`.
 *   - Trailing `/` denotes directory-only matching (stripped; path separator handles it).
 */
function linesToPatterns(lines: string[], prefix = ""): RegExp[] {
  const escapedPrefix = prefix
    ? prefix.replace(/[.+^${}()|[\]\\]/g, "\\$&") + "/"
    : "";
  return lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((pattern) => {
      // Trailing slash means directory-only; strip it
      const noTrailing = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;

      // Leading slash anchors to the gitignore's directory; strip it
      const hasLeadingSlash = noTrailing.startsWith("/");
      const clean = hasLeadingSlash ? noTrailing.slice(1) : noTrailing;

      // Anchored if explicit leading slash or interior slash present
      const isAnchored = hasLeadingSlash || clean.includes("/");

      // Escape regex special chars, then handle glob wildcards
      const escaped = clean
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\x00")   // placeholder so ** isn't touched by next replace
        .replace(/\*/g, "[^/]*")    // * must not cross directory boundaries
        .replace(/\?/g, "[^/]")     // ? must not cross directory boundaries
        .replace(/\x00/g, ".*");    // ** crosses directory boundaries

      if (isAnchored) {
        return new RegExp(`^${escapedPrefix}${escaped}(/|$)`);
      } else if (escapedPrefix) {
        return new RegExp(`^${escapedPrefix}(.*/)?${escaped}(/|$)`);
      } else {
        return new RegExp(`(^|/)${escaped}(/|$)`);
      }
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
