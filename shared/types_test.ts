/**
 * Unit tests for shared/types.ts
 */

import { test, expect } from "vitest";
import { modelToAgent, DEFAULT_MODEL_TIER } from "./types.ts";

// ─── modelToAgent ─────────────────────────────────────────────────────────────

test("modelToAgent: claude-haiku → claude", () => {
  expect(modelToAgent("claude-haiku")).toEqual("claude");
});

test("modelToAgent: claude-sonnet → claude", () => {
  expect(modelToAgent("claude-sonnet")).toEqual("claude");
});

test("modelToAgent: claude-opus → claude", () => {
  expect(modelToAgent("claude-opus")).toEqual("claude");
});

test("modelToAgent: codex → codex", () => {
  expect(modelToAgent("codex")).toEqual("codex");
});

test("modelToAgent: any claude-* prefix → claude", () => {
  // Future Claude tiers should also map to claude
  expect(modelToAgent("claude-future-model")).toEqual("claude");
});

test("modelToAgent: unknown non-codex string → claude", () => {
  // Anything that isn't "codex" maps to claude by current logic
  expect(modelToAgent("some-other")).toEqual("claude");
});

// ─── DEFAULT_MODEL_TIER ───────────────────────────────────────────────────────

test("DEFAULT_MODEL_TIER is claude-sonnet", () => {
  expect(DEFAULT_MODEL_TIER).toEqual("claude-sonnet");
});

test("DEFAULT_MODEL_TIER is a string", () => {
  expect(typeof DEFAULT_MODEL_TIER === "string").toBe(true);
});
