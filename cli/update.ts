import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ASH_DIR } from "./ash_dir.ts";
import { CLIENT_VERSION } from "../shared/protocol.ts";

const CACHE_FILE = join(ASH_DIR, ".update-check");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const FETCH_TIMEOUT_MS = 3_000;

interface Cache { ts: number; latest: string }

function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

async function readCache(): Promise<Cache | null> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf8")) as Cache;
  } catch {
    return null;
  }
}

function refreshInBackground(): void {
  (async () => {
    try {
      const res = await fetch("https://registry.npmjs.org/@doheon/ash/latest", {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const data = await res.json() as { version?: string };
      if (data.version) {
        await writeFile(CACHE_FILE, JSON.stringify({ ts: Date.now(), latest: data.version }), "utf8");
      }
    } catch { /* network errors are non-critical */ }
  })();
}

export async function warnIfUpdateAvailable(): Promise<void> {
  const cache = await readCache();

  // Refresh in background if cache is stale or missing
  if (!cache || Date.now() - cache.ts > CHECK_INTERVAL_MS) {
    refreshInBackground();
  }

  if (cache?.latest && semverGt(cache.latest, CLIENT_VERSION)) {
    process.stderr.write(
      `\n  update available  ${CLIENT_VERSION} → ${cache.latest}\n` +
      `  npm:   npm install -g @doheon/ash@latest\n` +
      `  brew:  brew upgrade ash\n\n`,
    );
  }
}
