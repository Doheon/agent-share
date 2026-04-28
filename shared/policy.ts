/**
 * Policy constants — single source of truth for economic parameters.
 *
 * Changing any value here is a minor-release event:
 *   - Bump POLICY_VERSION.
 *   - Bump the package minor (e.g. 0.1.x -> 0.2.0).
 *
 * Credit issuance rule: the only ways credit enters a user's balance are
 *   (a) an admin-signed MintEvent (verified in core/ledger/events.ts), or
 *   (b) an EarnEvent whose counterparty has a matching SpendEvent in their log.
 * A client that edits SIGNUP_BONUS locally gains nothing because replay does
 * not trust unsigned inflows.
 */
import { ADMIN_PUBKEY } from "./constants.ts";
import type { Model } from "./types.ts";

export const POLICY_VERSION = 2 as const;

/** Credits issued to a new user via an admin-signed `mint` with reason "signup". */
export const SIGNUP_BONUS = 100;

/**
 * Platform fee in basis points (100 bps = 1%). 0 disables fee entirely.
 * When non-zero, SpendEvent.amount stays as gross and EarnEvent.amount is
 * reduced by the treasury share.
 */
export const FEE_BPS = 0;

/** Max 10_000 bps = 100%. Enforced at call time, not here. */
export const FEE_BPS_MAX = 10_000;

/** Account that receives the treasury fee share. Same as admin for now. */
export const TREASURY_PUBKEY = ADMIN_PUBKEY;

/**
 * Canonical model registry. Used everywhere — do not duplicate.
 *
 * Credit costs are proportional to real API pricing (base: Haiku = 8cr).
 *   Haiku  : $0.80/$4 per MTok   → 1x   →  2 cr
 *   Sonnet : $3/$15 per MTok     → ~4x  →  6 cr
 *   Opus   : $15/$75 per MTok    → ~20x → 30 cr
 *   Codex  : $1.10/$4.40 per MTok → ~1x →  2 cr
 */
export const MODELS: readonly Model[] = [
  { tier: "claude-haiku",  display_name: "Claude Haiku",  credits: 2,  is_active: true },
  { tier: "claude-sonnet", display_name: "Claude Sonnet", credits: 6,  is_active: true },
  { tier: "claude-opus",   display_name: "Claude Opus",   credits: 30, is_active: true },
  { tier: "codex",         display_name: "Codex",         credits: 2,  is_active: true },
];

/** Tier -> credit cost. Derived from MODELS so the two never drift. */
export const MODEL_CREDITS: Record<string, number> = Object.fromEntries(
  MODELS.map((m) => [m.tier, m.credits]),
);

/**
 * Splits a gross credit charge into the acceptor's net earn and the treasury fee.
 * Acceptor-favoring rounding: treasury uses floor(), so small tasks round toward
 * paying the worker rather than the treasury.
 */
export function splitFee(gross: number): { acceptor: number; treasury: number } {
  if (!Number.isFinite(gross) || gross < 0) {
    return { acceptor: 0, treasury: 0 };
  }
  const treasury = Math.floor(gross * FEE_BPS / 10_000);
  return { acceptor: gross - treasury, treasury };
}
