"use client";

import { BN } from "@anchor-lang/core";
import type { SharedSnapshot } from "../../lib/shared";
import { readableAmount } from "../../lib/market-display";

type Outcome = "yes" | "no";
interface Props {
  snapshot: SharedSnapshot | null;
  loaded: boolean;
  failed: boolean;
  outcome: Outcome;
  decimals: number;
  symbol: string;
  disabled: boolean;
  onPrice: (value: string) => void;
}

/** A read-only price ladder. Selecting a price only edits the ticket; it never signs.
 * FIFO orders at the same price are summed with BN so large quantities stay exact.
 */
export function PredictionOrderBook({
  snapshot,
  loaded,
  failed,
  outcome,
  decimals,
  symbol,
  disabled,
  onPrice,
}: Props) {
  const sides = (["bid", "ask"] as const).map((side) => {
    const levels = new Map<string, { price: BN; quantity: BN }>();
    for (const { account } of snapshot?.orders ?? []) {
      if (
        !("open" in account.status) ||
        !(outcome in account.outcome) ||
        !(side in account.side)
      )
        continue;
      const key = account.price.toString();
      const previous = levels.get(key);
      levels.set(key, {
        price: account.price,
        quantity: (previous?.quantity ?? new BN(0)).add(
          account.remainingQuantity,
        ),
      });
    }
    return {
      side,
      rows: [...levels.values()].sort((a, b) =>
        side === "bid" ? b.price.cmp(a.price) : a.price.cmp(b.price),
      ),
    };
  });
  return (
    <section
      className="prediction-book"
      aria-labelledby="prediction-book-heading"
    >
      <div className="prediction-section-title">
        <h2 id="prediction-book-heading">Order book</h2>
        <span className={`outcome-text outcome-${outcome}`}>
          {outcome.toUpperCase()}
        </span>
      </div>
      {!loaded ? (
        <p className="prediction-empty-copy" role="status">
          {failed ? "Order book unavailable" : "Loading order book…"}
        </p>
      ) : !snapshot ? (
        <p className="prediction-empty-copy">Trading has not been enabled.</p>
      ) : (
        <div className="prediction-book-sides">
          {sides.map(({ side, rows }) => (
            <div key={side} className={`prediction-book-side book-${side}`}>
              <h3>{side === "bid" ? "Buy orders" : "Sell orders"}</h3>
              <div className="prediction-ladder-scroll">
                <table>
                  <caption className="sr-only">
                    {outcome.toUpperCase()} {side === "bid" ? "buy" : "sell"}{" "}
                    orders
                  </caption>
                  <thead>
                    <tr>
                      <th>Price ({symbol})</th>
                      <th>Contracts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ price, quantity }) => (
                      <tr key={price.toString()}>
                        <td>
                          <button
                            type="button"
                            disabled={disabled}
                            aria-label={`Use limit price ${readableAmount(price, decimals)} ${symbol}`}
                            onClick={() =>
                              onPrice(readableAmount(price, decimals))
                            }
                          >
                            {readableAmount(price, decimals)}
                          </button>
                        </td>
                        <td>{readableAmount(quantity, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 0 && (
                  <p className="prediction-empty-copy">
                    No {side === "bid" ? "buy" : "sell"} offers
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
