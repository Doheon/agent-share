/**
 * Single formatter for ledger events shared by `ash history` and the TUI
 * `/history` view. Both consumers iterate the same event log and produce
 * the same line layout — keeping the format here means adding a new event
 * variant updates both surfaces in lockstep, which is what bit us when
 * `earn_checkpoint` / `spend_checkpoint` got added but the TUI silently
 * dropped them.
 *
 * Returns the timestamp prefix and body separately so each caller (color
 * terminal vs ink Box) can apply its own styling without re-parsing.
 */
import type { Event } from "./events.ts";

export type EventKind = "earn" | "spend" | "mint";

export interface FormattedLedgerEvent {
  ts: string;
  body: string;
  kind: EventKind;
}

export function formatLedgerEvent(evt: Event): FormattedLedgerEvent | null {
  const ts = evt.timestamp.slice(0, 19).replace("T", " ");
  switch (evt.type) {
    case "earn":
      return {
        ts,
        kind: "earn",
        body: `earn   +${String(evt.amount).padStart(4)} cr  from ${evt.counterparty_pubkey.slice(0, 8)}…`,
      };
    case "spend":
      return {
        ts,
        kind: "spend",
        body: `spend  -${String(evt.amount).padStart(4)} cr  to   ${evt.counterparty_pubkey.slice(0, 8)}…`,
      };
    case "earn_checkpoint":
      return {
        ts,
        kind: "earn",
        body: `earn   +${String(evt.amount).padStart(4)} cr  from ${evt.counterparty_pubkey.slice(0, 8)}…  (bal: ${evt.balance})`,
      };
    case "spend_checkpoint":
      return {
        ts,
        kind: "spend",
        body: `spend  -${String(evt.amount).padStart(4)} cr  to   ${evt.counterparty_pubkey.slice(0, 8)}…  (bal: ${evt.balance})`,
      };
    case "mint":
      return {
        ts,
        kind: "mint",
        body: `mint   +${String(evt.amount).padStart(4)} cr  admin  (${evt.reason})`,
      };
    default:
      return null;
  }
}
