/**
 * Canonical JSON serialization — used as the signed payload for events.
 *
 * Rules:
 *   - Object keys sorted lexicographically at every level
 *   - No whitespace
 *   - undefined values are stripped
 *   - Arrays preserve order
 *
 * Two machines that hash the same logical object must produce the same bytes,
 * otherwise signatures won't verify cross-host.
 */

export function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON cannot contain NaN or Infinity");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return "{" + keys
      .map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k]))
      .join(",") + "}";
  }
  throw new Error(`Cannot canonicalize value of type ${typeof value}`);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalStringify(value));
}
