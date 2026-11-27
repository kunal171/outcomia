/** Pure helpers for multi-outcome Canton markets (2–8 named outcomes). */
import { amount, integer, list, raw, scale, type Contract } from "./model.ts";

/** Per-outcome totals of a holder's lots. */
export function lotTotals(lots: Contract[], outcomes: number): bigint[] {
  const totals = Array.from({ length: outcomes }, () => BigInt(0));
  for (const lot of lots)
    list(lot.data.counts).forEach((c, i) => {
      if (i < outcomes) totals[i] += integer(c);
    });
  return totals;
}

/** Exact collateral a holder receives: the winner's count, or each contract's
 * 1/N share when the market is invalid. */
export function multiClaim(totals: bigint[], winner: number | null): string {
  if (winner !== null) return amount((totals[winner] ?? BigInt(0)) * scale);
  const n = BigInt(totals.length);
  return amount(totals.reduce((sum, c) => sum + (c * scale) / n, BigInt(0)));
}

/** "Label: criterion" lines into standard outcome labels and criteria. A line
 * without a colon uses its label as the criterion. */
export function parseOutcomes(value: string) {
  const rows = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(":");
      const label = (at < 0 ? line : line.slice(0, at)).trim();
      const criterion = (at < 0 ? line : line.slice(at + 1)).trim() || label;
      return { label, criterion };
    });
  if (rows.length < 2 || rows.length > 8)
    throw new Error("List 2 to 8 outcomes, one per line.");
  return {
    outcomes: rows.map((r) => r.label),
    outcomeCriteria: rows.map((r) => r.criterion),
  };
}

export type OutcomeQuote = {
  bid?: string;
  ask?: string;
  /** Cost of this outcome via a full set: 1 minus the other outcomes' best bids. */
  impliedAsk?: string;
  /** Proceeds via a full set: 1 minus the other outcomes' best asks. */
  impliedBid?: string;
  last?: string;
};

/** Best bid/ask per outcome, implied prices through full sets, and the last
 * trade price. Example: bids 0.30/0.20/0.20 on the others imply 0.30 for the
 * fourth outcome. Inputs are exact decimal strings; outputs too. */
export function outcomeQuotes(
  outcomes: number,
  quotes: { side: string; outcome: string; price: string }[],
  fills: { kind: string; outcome?: string; price?: string }[] = [],
): OutcomeQuote[] {
  const best = (i: number, side: string) => {
    const prices = quotes
      .filter((q) => q.side === side && q.outcome === String(i))
      .map((q) => raw(q.price));
    if (!prices.length) return undefined;
    return prices.reduce((a, b) =>
      side === "Buy" ? (a > b ? a : b) : a < b ? a : b,
    );
  };
  const bids = Array.from({ length: outcomes }, (_, i) => best(i, "Buy"));
  const asks = Array.from({ length: outcomes }, (_, i) => best(i, "Sell"));
  const implied = (values: (bigint | undefined)[], i: number) => {
    const others = values.filter((_, j) => j !== i);
    if (others.some((x) => x === undefined)) return undefined;
    const sum = (others as bigint[]).reduce((total, x) => total + x, BigInt(0));
    const left = scale - sum;
    return left > BigInt(0) && left < scale ? amount(left) : undefined;
  };
  return Array.from({ length: outcomes }, (_, i) => {
    const last = fills.find(
      (f) => f.kind === "trade" && f.outcome === String(i),
    );
    return {
      bid: bids[i] === undefined ? undefined : amount(bids[i]!),
      ask: asks[i] === undefined ? undefined : amount(asks[i]!),
      impliedAsk: implied(bids, i),
      impliedBid: implied(asks, i),
      last: last?.price ? amount(raw(last.price)) : undefined,
    };
  });
}
