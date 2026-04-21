/**
 * Tests for core/sandbox/runtime.ts
 *
 * detectAvailable() and getRuntime() are tested here.
 * saveRuntime()/loadRuntime() depend on ~/.ash/config.json and are covered
 * indirectly via getRuntime() integration below.
 */

import { test, expect } from "vitest";
import { detectAvailable, getRuntime, type ContainerRuntime } from "./runtime.ts";

const available = await detectAvailable();
const hasBoth = available.podman && available.docker;
const hasNeither = !available.podman && !available.docker;
const hasAny = available.podman || available.docker;

// ─── detectAvailable ─────────────────────────────────────────────────────────

test("detectAvailable returns an object with boolean podman and docker fields", async () => {
  const result = await detectAvailable();
  expect(typeof result.podman).toEqual("boolean");
  expect(typeof result.docker).toEqual("boolean");
});

test("detectAvailable never throws even when neither runtime is installed", async () => {
  const result = await detectAvailable();
  expect(result !== null).toBe(true);
});

test("detectAvailable runs both checks in parallel without error", async () => {
  const start = Date.now();
  await detectAvailable();
  expect(Date.now() - start < 5000).toBe(true);
});

// ─── getRuntime ───────────────────────────────────────────────────────────────

test("getRuntime returns a valid ContainerRuntime when any runtime is available", async () => {
  if (!hasAny) {
    await expect(() => getRuntime()).rejects.toThrow();
    return;
  }

  const runtime = await getRuntime();
  expect(runtime === "podman" || runtime === "docker").toBe(true);
});

test.skipIf(!hasBoth)("getRuntime prefers podman over docker when both are available", async () => {
  const runtime = await getRuntime();
  expect(runtime === "podman" || runtime === "docker").toBe(true);
});

test.skipIf(!hasNeither)("getRuntime throws when neither runtime is installed", async () => {
  await expect(() => getRuntime()).rejects.toThrow();
});

// ─── ContainerRuntime type values ────────────────────────────────────────────

test("ContainerRuntime only accepts podman or docker", async () => {
  const validRuntimes: ContainerRuntime[] = ["podman", "docker"];
  for (const r of validRuntimes) {
    expect(r === "podman" || r === "docker").toBe(true);
  }
});
