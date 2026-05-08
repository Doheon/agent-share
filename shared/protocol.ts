/**
 * P2P protocol versioning. Peers exchange this in `peer:info` so that
 * incompatible clients can refuse to negotiate.
 *
 * Balance enforcement is always active — requesters must hold sufficient
 * credits before tasks are accepted.
 */

export const PROTOCOL_VERSION = 2 as const;
export const CLIENT_VERSION = "0.1.5" as const;

/** Maximum size of a packed task blob (raw bytes). Enforced both at pack-time
 *  by the requester and at unpack-time by the acceptor. Also rejected at the
 *  swarm message layer so a malicious peer cannot OOM peers with oversized
 *  blob announcements. */
export const MAX_BLOB_SIZE = 100 * 1024 * 1024; // 100MB

/** Base64 encoding inflates the byte size by ~4/3. Add a small slack for
 *  whitespace tolerance. Used to bound the size of `task:blob.data` strings. */
export const MAX_BLOB_SIZE_B64 = Math.ceil((MAX_BLOB_SIZE * 4) / 3) + 1024;

/** Raw bytes per chunk in chunked blob transfer. */
export const CHUNK_BYTES = 512 * 1024;

/** Max base64 length of a single chunk's `data` field (with small slack). */
export const MAX_CHUNK_B64 = Math.ceil(CHUNK_BYTES * 4 / 3) + 16;
