import { join } from "node:path";
import { ASH_DIR } from "../../cli/ash_dir.ts";

const STORE_PATH = join(ASH_DIR, "corestore");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _storePromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getCorestore(): Promise<any> {
  if (_storePromise) return _storePromise;
  _storePromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { default: Corestore } = (await import("corestore")) as any;
    const store = new Corestore(STORE_PATH);
    try {
      await store.ready();
    } catch (err) {
      _storePromise = null;
      if ((err as Error).message?.includes("could not be locked")) {
        throw new Error("Corestore locked: another ash process is already running");
      }
      throw err;
    }
    return store;
  })();
  return _storePromise;
}

export async function closeCorestore(): Promise<void> {
  if (!_storePromise) return;
  try {
    const store = await _storePromise;
    await store.close();
  } catch { /* ignore */ }
  _storePromise = null;
}
