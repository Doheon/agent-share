import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface WalkEntry {
  path: string;
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export async function* walk(dir: string): AsyncGenerator<WalkEntry> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const path = join(dir, e.name);
    yield { path, name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() };
    if (e.isDirectory()) yield* walk(path);
  }
}
