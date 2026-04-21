import { test, expect } from "vitest";
import { PROTOCOL_VERSION, CLIENT_VERSION } from "./protocol.ts";

test("PROTOCOL_VERSION is a positive integer", () => {
  expect(typeof PROTOCOL_VERSION).toEqual("number");
  expect(Number.isInteger(PROTOCOL_VERSION)).toEqual(true);
  expect(PROTOCOL_VERSION >= 1).toEqual(true);
});

test("CLIENT_VERSION is a non-empty semver-shaped string", () => {
  expect(typeof CLIENT_VERSION).toEqual("string");
  expect(CLIENT_VERSION.length > 0).toEqual(true);
  expect(/^\d+\.\d+\.\d+/.test(CLIENT_VERSION)).toEqual(true);
});
