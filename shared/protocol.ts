/**
 * P2P protocol versioning. Peers exchange this in `peer:info` so that
 * incompatible clients can refuse to negotiate.
 *
 * Balance enforcement is always active — requesters must hold sufficient
 * credits before tasks are accepted.
 */

export const PROTOCOL_VERSION = 1 as const;
export const CLIENT_VERSION = "0.1.1" as const;

/** Maximum size of a packed task blob (raw bytes). Enforced both at pack-time
 *  by the requester and at unpack-time by the acceptor. Also rejected at the
 *  swarm message layer so a malicious peer cannot OOM peers with oversized
 *  blob announcements. */
export const MAX_BLOB_SIZE = 45 * 1024 * 1024; // 45MB

/** Base64 encoding inflates the byte size by ~4/3. Add a small slack for
 *  whitespace tolerance. Used to bound the size of `task:blob.data` strings. */
export const MAX_BLOB_SIZE_B64 = Math.ceil((MAX_BLOB_SIZE * 4) / 3) + 1024;
