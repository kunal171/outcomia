"use client";
import { useI18n } from "./preferences-provider";

import { useEffect, useState } from "react";
import { AnchorProvider, BN, type Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import {
  derivePredictionBookPda,
  derivePredictionPositionPda,
  PREDICTION_MATCHING_ENABLED,
  PREDICTION_ORDERS_ENABLED,
  type PredictionOutcome,
} from "../lib/prediction";
import {
  buildPredictionMatchTransaction,
  MAX_PREDICTION_MATCHES_PER_TRANSACTION,
  planPredictionMatches,
  canPostPredictionRemainder,
} from "../lib/prediction-matching-plan";
import { buildPredictionPlacement } from "../lib/prediction-placement";
import {
  deriveMarketFeesPda,
  deriveProtocolConfigPda,
  formatAtomicAmount,
  getTidebookAccounts,
  parseTokenAmount,
  type OrderSide,
} from "../lib/tidebook";

interface Props {
  program: Program;
  owner: PublicKey;
  market: PublicKey;
  decimals: number;
  symbol: string;
  pending: boolean;
  setPending: (value: boolean) => void;
  onMatched: (signature: string, order: PublicKey | null) => void;
}

/** Bounded atomic matching with explicit limit or immediate-only execution.
 * Pre-signing reads refresh the quote, but concurrent fills can still change
 * the result. Confirmation reports the transaction, not a fabricated fill. */
export function PredictionMatchForm({
  program,
  owner,
  market,
  decimals,
  symbol,
  pending,
  setPending,
  onMatched,
}: Props) {
  const { t } = useI18n();

  const [outcome, setOutcome] = useState<PredictionOutcome>("yes");
  const [side, setSide] = useState<OrderSide>("bid");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [execution, setExecution] = useState<"limit" | "immediate">("limit");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [closeTs, setCloseTs] = useState<BN | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  async function quote() {
    if (!/^\d+$/.test(quantity.trim()))
      throw new Error("Enter a positive whole contract quantity");
    const rawQuantity = new BN(quantity.trim());
    const limit = parseTokenAmount(price, decimals, "Limit price");
    const accounts = getTidebookAccounts(program);
    const [book, config, terms, position, fees] = await Promise.all([
      accounts.predictionOrderBook.fetchNullable(
        derivePredictionBookPda(market),
      ),
      accounts.protocolConfig.fetchNullable(deriveProtocolConfigPda()),
      accounts.predictionMarket.fetchNullable(market),
      accounts.predictionPosition.fetchNullable(
        derivePredictionPositionPda(market, owner),
      ),
      accounts.marketFees.fetchNullable(deriveMarketFeesPda(market)),
    ]);
    if (!book || !config || !terms || !position || !fees)
      throw new Error("Market, book, position or fee accounts are unavailable");
    if (
      !fees.market.equals(market) ||
      !fees.quoteMint.equals(terms.collateralMint)
    )
      throw new Error("Fee account belongs to a different market or mint");
    const plan = await planPredictionMatches(
      accounts,
      {
        marketAddress: market,
        taker: owner,
        outcome,
        side,
        limitPrice: limit,
        quantity: rawQuantity,
      },
      terms,
      book,
      position,
      config.takerFeeBps,
      fees.accruedQuoteFees,
      new BN(Math.floor(Date.now() / 1000)),
    );
    const post = execution === "limit" && canPostPredictionRemainder(plan);
    if (post && !PREDICTION_ORDERS_ENABLED)
      throw new Error(
        "Resting orders are disabled in this app configuration. Select immediate only to match without posting.",
      );
    const placement = post
      ? await buildPredictionPlacement(
          program,
          accounts,
          market,
          owner,
          plan.finalMarket,
          plan.finalBook,
          plan.finalPosition,
          outcome,
          side,
          limit,
          plan.remainingQuantity,
          new BN(Math.floor(Date.now() / 1000)),
        )
      : null;
    if (!plan.steps.length && !placement)
      throw new Error(
        plan.stopReason === "book-exhausted"
          ? "No opposing orders for this outcome"
          : "Limit price does not cross the best order",
      );
    // Measure the complete transaction before presenting it as signable. In
    // particular three makers plus a new level can exceed the legacy packet.
    const transaction = await buildPredictionMatchTransaction(
      program,
      plan,
      placement?.instruction,
    );
    return { plan, closeTs: terms.closeTs, placement, transaction };
  }
  useEffect(() => {
    let canceled = false;
    setPreview(null);
    setCloseTs(null);
    setError(null);
    if (!price.trim() || !quantity.trim()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void quote()
        .then(({ plan, closeTs, placement }) => {
          if (canceled) return;
          setCloseTs(closeTs);
          setPreview(
            `${plan.request.quantity.sub(plan.remainingQuantity).toString()} ${outcome.toUpperCase()} contracts matched across ${plan.steps.length} orders. ${side === "bid" ? "Pay" : "Receive"} ${formatAtomicAmount(plan.totalCash, decimals)} ${symbol}, including ${formatAtomicAmount(plan.totalFee, decimals)} fee. ${placement ? `${plan.remainingQuantity.toString()} contracts rest at your limit, locking ${side === "bid" ? `${formatAtomicAmount(placement.locked, decimals)} ${symbol}` : `${placement.locked.toString()} contracts`}.` : `${plan.remainingQuantity.toString()} contracts remain unposted.`} ${plan.stopReason === "match-cap" ? "Three-order limit reached. Crossing orders remain; submit again to continue." : ""}`,
          );
        })
        .catch((cause) => {
          if (!canceled)
            setError(
              cause instanceof Error ? cause.message : "Unable to quote trade",
            );
        })
        .finally(() => {
          if (!canceled) setLoading(false);
        });
    }, 250);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
    // Timer updates below enforce close locally without polling RPC every second.
  }, [
    program,
    owner,
    market,
    decimals,
    symbol,
    outcome,
    side,
    price,
    quantity,
    execution,
    refresh,
  ]);
  const closed = closeTs !== null && new BN(now).gte(closeTs);
  async function submit() {
    if (
      pending ||
      loading ||
      !preview ||
      closed ||
      !PREDICTION_MATCHING_ENABLED
    )
      return;
    setPending(true);
    setError(null);
    try {
      const { transaction, placement } = await quote();
      const signature = await (
        program.provider as AnchorProvider
      ).sendAndConfirm(transaction);
      // A concurrent partial fill can reduce execution after the preview. Only
      // a future transaction-event reader can report its exact confirmed fill.
      onMatched(signature, placement?.order ?? null);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Trade failed");
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className={`market-create-form prediction-trade prediction-trade-${side}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <h3>{t("Take a position")}</h3>
      </div>
      <p>
        {t(
          "Choose YES or NO, then set your price. Orders match up to {value0} resting orders at their prices. A winning contract pays 1 {value1} after resolution.",
          { value0: MAX_PREDICTION_MATCHES_PER_TRANSACTION, value1: symbol },
        )}
      </p>
      {!PREDICTION_MATCHING_ENABLED && (
        <p>{t("Prediction trading is disabled in this app configuration.")}</p>
      )}
      <label>
        {t("Execution")}
        <select
          value={execution}
          disabled={pending}
          onChange={(event) => {
            setPreview(null);
            setExecution(event.target.value as "limit" | "immediate");
          }}
        >
          <option value="limit">
            {t("Limit — match, then rest the remainder")}
          </option>
          <option value="immediate">
            {t("Immediate only — leave remainder unposted")}
          </option>
        </select>
      </label>
      <label>
        {t("Outcome")}
        <select
          value={outcome}
          disabled={pending}
          onChange={(event) => {
            setPreview(null);
            setOutcome(event.target.value as PredictionOutcome);
          }}
        >
          <option value="yes">{t("YES")}</option>
          <option value="no">{t("NO")}</option>
        </select>
      </label>
      <label>
        {t("Action")}
        <select
          value={side}
          disabled={pending}
          onChange={(event) => {
            setPreview(null);
            setSide(event.target.value as OrderSide);
          }}
        >
          <option value="bid">{t("Buy contracts")}</option>
          <option value="ask">{t("Sell contracts")}</option>
        </select>
      </label>
      <label>
        {t("{value0} price per contract ({value1})", {
          value0: side === "bid" ? t("Maximum") : t("Minimum"),
          value1: symbol,
        })}
        <input
          inputMode="decimal"
          value={price}
          disabled={pending}
          onChange={(event) => {
            setPreview(null);
            setPrice(event.target.value);
          }}
          placeholder="0.60"
        />
      </label>
      <label>
        {t("Whole contracts")}
        <input
          inputMode="numeric"
          value={quantity}
          disabled={pending}
          onChange={(event) => {
            setPreview(null);
            setQuantity(event.target.value);
          }}
          placeholder="1"
        />
      </label>
      {loading && <p role="status">{t("Reading the best order and fees…")}</p>}
      {preview && (
        <p className="prediction-preview" role="status">
          {t(
            "Preview: {value0} Refreshes before signing; execution can change.",
            { value0: preview },
          )}
        </p>
      )}
      {closed && (
        <p>{t("Trading has closed. You can still cancel open orders.")}</p>
      )}
      {error && (
        <p className="access-denied" role="alert">
          {t(error ?? "")}
        </p>
      )}
      <button
        className="text-button"
        type="button"
        disabled={pending || loading}
        onClick={() => setRefresh((value) => value + 1)}
      >
        {t("Refresh quote")}
      </button>
      <button
        className="primary-button"
        type="submit"
        disabled={
          pending ||
          loading ||
          closed ||
          !preview ||
          !!error ||
          !PREDICTION_MATCHING_ENABLED
        }
      >
        {pending
          ? t("Confirming…")
          : `${side === "bid" ? t("Buy") : t("Sell")} ${outcome.toUpperCase()}`}
      </button>
    </form>
  );
}
