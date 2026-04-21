/**
 * P2P protocol versioning. Peers exchange this in `peer:info` so that
 * incompatible clients can refuse to negotiate.
 *
 * Balance enforcement is always active — requesters must hold sufficient
 * credits before tasks are accepted.
 */

export const PROTOCOL_VERSION = 2 as const;
export const CLIENT_VERSION = "0.1.0" as const;
