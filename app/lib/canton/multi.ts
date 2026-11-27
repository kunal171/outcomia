/** Pure helpers for multi-outcome Canton markets (2–8 named outcomes). */
import {
  amount,
  finalRecord,
  integer,
  list,
  marketKey,
  multiResult,
  obj,
  raw,
  scale,
  text,
  type Contract,
} from "./model.ts";

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

export type MultiPosition = {
  key: string;
  lots: Contract[];
  /** Collateral instrument id, from the market's terms ("" if unknown). */
  collateral: string;
  /** Outcome labels with the holder's count of each, in outcome order. */
  holdings: { label: string; count: bigint }[];
  /** Present once the market is settled: what redeeming pays and where. */
  claim?: { value: string; settled: string };
};

/** A holder's multi-outcome lots grouped by market, labelled from the market's
 * terms, with the claim value once its settled reserve exists. The latest
 * market record (final over proposal over market) supplies the labels. */
export function multiPositions(
  contracts: Contract[],
  owned: Contract[],
  party: string | undefined,
): MultiPosition[] {
  if (!party) return [];
  const groups = new Map<string, Contract[]>();
  for (const lot of owned)
    if (lot.kind === "MultiLot" && lot.data.owner === party) {
      const key = marketKey(lot.data);
      groups.set(key, [...(groups.get(key) ?? []), lot]);
    }
  const keyOf = (c: Contract) => {
    try {
      return marketKey(finalRecord(c));
    } catch {
      return undefined;
    }
  };
  const rank = { MultiMarket: 1, MultiProposal: 2, MultiFinal: 3 } as const;
  return [...groups].map(([key, lots]) => {
    const record = contracts
      .filter((c) => c.kind in rank && keyOf(c) === key)
      .sort(
        (a, b) =>
          rank[b.kind as keyof typeof rank] - rank[a.kind as keyof typeof rank],
      )[0];
    const terms = record ? obj(finalRecord(record).terms) : undefined;
    const labels = terms ? list(terms.outcomes).map(text) : [];
    const collateral = terms ? text(obj(terms.collateral).id) : "";
    const n = labels.length || list(lots[0].data.counts).length;
    const totals = lotTotals(lots, n);
    const settled = contracts.find(
      (c) => c.kind === "MultiSettledReserve" && keyOf(c) === key,
    );
    // Redemption takes at most 16 lots per transaction, as the command does.
    const claim = settled
      ? {
          value: multiClaim(
            lotTotals(lots.slice(0, 16), n),
            multiResult(settled.data.result).winner,
          ),
          settled: settled.id,
        }
      : undefined;
    return {
      key,
      lots,
      collateral,
      holdings: totals.map((count, i) => ({
        label: labels[i] ?? `Outcome ${i + 1}`,
        count,
      })),
      claim,
    };
  });
}
