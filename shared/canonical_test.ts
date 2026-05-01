import { test, expect } from "vitest";
import { canonicalStringify } from "./canonical.ts";

// Regression tests for surrogate-pair handling. A relay re-decoding
// JSON as UTF-8 would replace lone surrogates with U+FFFD, breaking
// signature verification cross-host — canonicalize must reject them.
test("rejects lone high surrogate", () => {
  expect(() => canonicalStringify("\uD800")).toThrow(/lone high surrogate/);
});

test("rejects lone low surrogate", () => {
  expect(() => canonicalStringify("\uDC00")).toThrow(/lone low surrogate/);
});

test("rejects lone surrogate inside an object value", () => {
  expect(() => canonicalStringify({ x: "\uD83D" })).toThrow(/lone high surrogate/);
});

test("accepts a valid surrogate pair (emoji)", () => {
  expect(canonicalStringify({ x: "🚀" })).toBe('{"x":"🚀"}');
});

test("primitives", () => {
  expect(canonicalStringify(null)).toBe("null");
  expect(canonicalStringify(true)).toBe("true");
  expect(canonicalStringify(1)).toBe("1");
  expect(canonicalStringify("x")).toBe('"x"');
});

test("object keys sorted lexicographically", () => {
  const a = canonicalStringify({ b: 2, a: 1, c: 3 });
  expect(a).toBe('{"a":1,"b":2,"c":3}');
});

test("nested objects sorted at every level", () => {
  const s = canonicalStringify({ z: { y: 1, x: 2 }, a: [3, { n: 1, m: 2 }] });
  expect(s).toBe('{"a":[3,{"m":2,"n":1}],"z":{"x":2,"y":1}}');
});

test("arrays preserve order", () => {
  expect(canonicalStringify([3, 1, 2])).toBe("[3,1,2]");
});

test("undefined values stripped", () => {
  expect(canonicalStringify({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
});

test("same object with different key orders produces identical bytes", () => {
  const s1 = canonicalStringify({ z: 1, a: 2, m: { y: 1, x: 2 } });
  const s2 = canonicalStringify({ m: { x: 2, y: 1 }, a: 2, z: 1 });
  expect(s1).toBe(s2);
});

test("NaN/Infinity rejected", () => {
  expect(() => canonicalStringify(NaN)).toThrow();
  expect(() => canonicalStringify(Infinity)).toThrow();
});
