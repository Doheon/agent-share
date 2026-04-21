/**
 * Unit tests for shared/policy.ts
 */

import { test, expect, describe } from "vitest";
import {
  FEE_BPS,
  MODELS,
  MODEL_CREDITS,
  POLICY_VERSION,
  SIGNUP_BONUS,
  splitFee,
} from "./policy.ts";

describe("policy constants", () => {
  test("POLICY_VERSION is a positive integer", () => {
    expect(Number.isInteger(POLICY_VERSION)).toBe(true);
    expect(POLICY_VERSION).toBeGreaterThan(0);
  });

  test("SIGNUP_BONUS is a non-negative integer", () => {
    expect(Number.isInteger(SIGNUP_BONUS)).toBe(true);
    expect(SIGNUP_BONUS).toBeGreaterThanOrEqual(0);
  });

  test("FEE_BPS is within [0, 10_000]", () => {
    expect(FEE_BPS).toBeGreaterThanOrEqual(0);
    expect(FEE_BPS).toBeLessThanOrEqual(10_000);
  });

  test("MODEL_CREDITS mirrors MODELS exactly (no drift)", () => {
    expect(Object.keys(MODEL_CREDITS).sort()).toEqual(MODELS.map((m) => m.tier).sort());
    for (const m of MODELS) {
      expect(MODEL_CREDITS[m.tier]).toBe(m.credits);
    }
  });

  test("every MODELS entry has a positive integer cost", () => {
    for (const m of MODELS) {
      expect(Number.isInteger(m.credits)).toBe(true);
      expect(m.credits).toBeGreaterThan(0);
    }
  });
});

describe("splitFee", () => {
  test("FEE_BPS=0 → treasury=0 and acceptor=gross", () => {
    // Current compile-time invariant: FEE_BPS is 0 for v0.1.
    expect(FEE_BPS).toBe(0);
    expect(splitFee(0)).toEqual({ acceptor: 0, treasury: 0 });
    expect(splitFee(1)).toEqual({ acceptor: 1, treasury: 0 });
    expect(splitFee(25)).toEqual({ acceptor: 25, treasury: 0 });
    expect(splitFee(10_000)).toEqual({ acceptor: 10_000, treasury: 0 });
  });

  test("negative or non-finite input yields zero split", () => {
    expect(splitFee(-1)).toEqual({ acceptor: 0, treasury: 0 });
    expect(splitFee(Number.NaN)).toEqual({ acceptor: 0, treasury: 0 });
    expect(splitFee(Number.POSITIVE_INFINITY)).toEqual({ acceptor: 0, treasury: 0 });
  });

  test("acceptor + treasury always equals gross for valid inputs", () => {
    for (const g of [0, 1, 7, 25, 100, 9999, 100_000]) {
      const s = splitFee(g);
      expect(s.acceptor + s.treasury).toBe(g);
    }
  });
});
