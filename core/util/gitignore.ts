import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Loads `.gitignore` patterns and converts them to RegExp matchers.
 *
 * Limitations vs full gitignore semantics (documented):
 *   - `!negation` lines are SKIPPED rather than implemented as un-ignore.
 *     A previous version converted `!build` into a literal `\!build`
 *     pattern that effectively re-included the file under a wrong name.
 *     Skipping is the safer default for a v0.1 packing path — falsely
 *     ignoring is worse than falsely shipping.
 *   - `**` is approximated by `.*`, no path-segment-anchored matching.
 *   - Trailing-slash directory-only matching is not enforced.
 */
export async function loadGitignorePatterns(dir: string): Promise<RegExp[]> {
  try {
    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      // Skip negation lines — see limitation above. Without this, a
      // line like `!keep.txt` was being turned into a literal pattern
      // that ignored every path containing `!keep.txt`.
      .filter((l) => !l.startsWith("!"))
      .map((pattern) => {
        // Strip trailing slash — gitignore uses it to mark directory-only
        // patterns, but our regex already anchors on path separators so the
        // slash would prevent matching deeper paths (e.g. `venv/` would fail
        // to match `venv/lib/...` because `venv/` + `(/|$)` requires a
        // second `/` immediately after).
        const clean = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
        const escaped = clean
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".");
        return new RegExp(`(^|/)${escaped}(/|$)`);
      });
  } catch {
    return [];
  }
}
