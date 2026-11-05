"use client";

import { useEffect, useState } from "react";
import { type Program } from "@anchor-lang/core";
import { type PublicKey } from "@solana/web3.js";
import {
  derivePredictionBookPda,
  type PredictionOutcome,
} from "../lib/prediction";
import {
  readPredictionDepth,
  type PredictionDepth,
} from "../lib/prediction-book";
import { formatAtomicAmount, getTidebookAccounts } from "../lib/tidebook";

/** Public depth needs no wallet. A failed refresh clears stale rows visibly. */
export function PredictionBook({
  program,
  market,
  decimals,
  symbol,
  revision,
}: {
  program: Program;
  market: PublicKey;
  decimals: number;
  symbol: string;
  revision: string;
}) {
  const [outcome, setOutcome] = useState<PredictionOutcome>("yes");
  const [depth, setDepth] = useState<{
    bids: PredictionDepth;
    asks: PredictionDepth;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setDepth(null);
    setError(null);
    async function load() {
      const accounts = getTidebookAccounts(program);
      const book = await accounts.predictionOrderBook.fetchNullable(
        derivePredictionBookPda(market),
      );
      if (!book)
        throw new Error(
          "This market has no order book. Create a fresh draft with the updated program.",
        );
      const [bids, asks] = await Promise.all([
        readPredictionDepth(
          accounts.predictionPriceLevel,
          market,
          book,
          outcome,
          "bid",
        ),
        readPredictionDepth(
          accounts.predictionPriceLevel,
          market,
          book,
          outcome,
          "ask",
        ),
      ]);
      if (!canceled) setDepth({ bids, asks });
    }
    void load()
      .catch((cause) => {
        if (!canceled)
          setError(
            cause instanceof Error ? cause.message : "Unable to read depth",
          );
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [program, market, outcome, revision, refresh]);
  return (
    <section className="prediction-depth" aria-busy={loading}>
      <div className="market-list-heading">
        <div>
          <span className="eyebrow">Live account snapshot</span>
          <h2>Order book</h2>
        </div>
        <button
          className="text-button"
          type="button"
          disabled={loading}
          onClick={() => setRefresh((n) => n + 1)}
        >
          Refresh depth
        </button>
      </div>
      <div
        className="prediction-tabs"
        role="group"
        aria-label="Order book outcome"
      >
        {(["yes", "no"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={outcome === value}
            onClick={() => {
              setDepth(null);
              setOutcome(value);
            }}
          >
            {value.toUpperCase()}
          </button>
        ))}
      </div>
      {loading && <p role="status">Reading {outcome.toUpperCase()} prices…</p>}
      {error && (
        <p className="access-denied" role="alert">
          {error}
        </p>
      )}
      {depth && (
        <div className="order-book-grid">
          {(["bids", "asks"] as const).map((side) => (
            <div className="order-book-side" key={side}>
              <h3>{side === "bids" ? "Buy orders" : "Sell orders"}</h3>
              <table
                className={`prediction-depth-table order-book-${side === "bids" ? "bid" : "ask"}`}
              >
                <caption className="sr-only">
                  {outcome.toUpperCase()} {side}, best price first
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Price ({symbol})</th>
                    <th scope="col">Contracts</th>
                    <th scope="col">Orders</th>
                  </tr>
                </thead>
                <tbody>
                  {depth[side].levels.map((level) => (
                    <tr key={level.price.toString()}>
                      <td>{formatAtomicAmount(level.price, decimals)}</td>
                      <td>{level.totalRemainingQuantity.toString()}</td>
                      <td>{level.orderCount.toString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!depth[side].levels.length && (
                <p className="order-book-empty">
                  No {outcome.toUpperCase()} {side === "bids" ? "buy" : "sell"}{" "}
                  orders yet.
                </p>
              )}
              {depth[side].hasMore && <p>Showing the best 20 prices.</p>}
            </div>
          ))}
        </div>
      )}
      <p className="order-book-note">
        Prices are collateral per contract. Depth shows remaining contracts at
        each price, not a last-trade price. Refresh to see new orders.
      </p>
    </section>
  );
}
