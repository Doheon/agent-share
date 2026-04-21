import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadGitignorePatterns(dir: string): Promise<RegExp[]> {
  try {
    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((pattern) => {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
        return new RegExp(`(^|/)${escaped}(/|$)`);
      });
  } catch {
    return [];
  }
}
