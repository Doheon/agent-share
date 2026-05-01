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
      const msg = (err as Error).message ?? "";
      if (msg.includes("could not be locked")) {
        throw new Error(
          "Corestore locked: another ash process is already running.\n" +
          "  If no other ash is running, the lock file may be stale —\n" +
          `  remove ${STORE_PATH} and re-run.`,
        );
      }
      // Common corruption signatures from hypercore/random-access-file.
      if (
        msg.includes("Could not decode") ||
        msg.includes("invalid signature") ||
        msg.includes("ENOENT") && msg.includes("corestore") ||
        msg.includes("checksum")
      ) {
        throw new Error(
          `Corestore at ${STORE_PATH} appears corrupted (${msg}).\n` +
          `  Back it up and start fresh:\n` +
          `    mv ${STORE_PATH} ${STORE_PATH}.bak\n` +
          `    ash init    # signs a new SignupEvent on a fresh log`,
        );
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
