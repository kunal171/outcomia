/** Pure helpers for multi-outcome Canton markets (2–8 named outcomes). */
import { amount, integer, list, scale, type Contract } from "./model.ts";

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
