"use client";
import { useI18n } from "./preferences-provider";

import { SHARED_BALANCES_ENABLED } from "../lib/shared";

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
  const { t } = useI18n();

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
          <h2>
            {SHARED_BALANCES_ENABLED ? t("Legacy order book") : t("Order book")}
          </h2>
        </div>
        <button
          className="text-button"
          type="button"
          disabled={loading}
          onClick={() => setRefresh((n) => n + 1)}
        >
          {t("Refresh depth")}
        </button>
      </div>
      <div
        className="prediction-tabs"
        role="group"
        aria-label={t("Order book outcome")}
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
      {loading && (
        <p role="status">
          {t("Reading {value0} prices…", { value0: outcome.toUpperCase() })}
        </p>
      )}
      {error && (
        <p className="access-denied" role="alert">
          {t(error ?? "")}
        </p>
      )}
      {depth && (
        <div className="order-book-grid">
          {(["bids", "asks"] as const).map((side) => (
            <div className="order-book-side" key={side}>
              <h3>{side === "bids" ? t("Buy orders") : t("Sell orders")}</h3>
              <table
                className={`prediction-depth-table order-book-${side === "bids" ? "bid" : "ask"}`}
              >
                <caption className="sr-only">
                  {t("{value0}  {value1}, best price first", {
                    value0: outcome.toUpperCase(),
                    value1: side,
                  })}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {t("Price ({value0})", { value0: symbol })}
                    </th>
                    <th scope="col">{t("Contracts")}</th>
                    <th scope="col">{t("Orders")}</th>
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
                  {t("No {value0}  {value1} orders yet.", {
                    value0: outcome.toUpperCase(),
                    value1: side === "bids" ? t("buy") : t("sell"),
                  })}
                </p>
              )}
              {depth[side].hasMore && <p>{t("Showing the best 20 prices.")}</p>}
            </div>
          ))}
        </div>
      )}
      <p className="order-book-note">
        {t(
          "Prices are collateral per contract. Depth shows remaining contracts at each price, not a last-trade price. Refresh to see new orders.",
        )}
      </p>
    </section>
  );
}
