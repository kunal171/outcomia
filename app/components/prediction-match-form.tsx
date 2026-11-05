"use client";

import { useEffect, useState } from "react";
import { AnchorProvider, BN, type Program } from "@anchor-lang/core";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  derivePredictionBookPda,
  derivePredictionPositionPda,
  PREDICTION_MATCHING_ENABLED,
  readPredictionMatchTarget,
  validatePredictionMatch,
  type PredictionOutcome,
} from "../lib/prediction";
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
  onMatched: (signature: string) => void;
}

/** One maker per submission; unfilled quantity is never silently posted.
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
  const [outcome, setOutcome] = useState<PredictionOutcome>("yes");
  const [side, setSide] = useState<OrderSide>("bid");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
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
    const [book, config, terms, position] = await Promise.all([
      accounts.predictionOrderBook.fetchNullable(
        derivePredictionBookPda(market),
      ),
      accounts.protocolConfig.fetchNullable(deriveProtocolConfigPda()),
      accounts.predictionMarket.fetchNullable(market),
      accounts.predictionPosition.fetchNullable(
        derivePredictionPositionPda(market, owner),
      ),
    ]);
    if (!book || !config || !terms || !position)
      throw new Error(
        "Market, book, position or fee configuration is unavailable",
      );
    const target = await readPredictionMatchTarget(
      accounts,
      market,
      book,
      outcome,
      side,
      rawQuantity,
    );
    const plan = validatePredictionMatch(
      terms,
      book,
      position,
      target,
      outcome,
      side,
      limit,
      rawQuantity,
      config.takerFeeBps,
      owner,
      new BN(Math.floor(Date.now() / 1000)),
    );
    return { target, plan, rawQuantity, limit, closeTs: terms.closeTs };
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
        .then(({ plan, closeTs }) => {
          if (canceled) return;
          setCloseTs(closeTs);
          setPreview(
            `${plan.fill.toString()} ${outcome.toUpperCase()} contracts; ${side === "bid" ? "pay" : "receive"} ${formatAtomicAmount(plan.cash, decimals)} ${symbol}, including ${formatAtomicAmount(plan.fee, decimals)} fee. ${plan.unfilled.toString()} requested contracts remain unposted.`,
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
      const { target, rawQuantity, limit } = await quote();
      const ix = await program.methods
        .matchPredictionOrder(
          { [outcome]: {} },
          { [side]: {} },
          limit,
          rawQuantity,
        )
        .accountsStrict({
          taker: owner,
          market,
          orderBook: derivePredictionBookPda(market),
          protocolConfig: deriveProtocolConfigPda(),
          marketFees: deriveMarketFeesPda(market),
          makerOrder: target.makerAddress,
          priceLevel: target.levelAddress,
          makerPosition: derivePredictionPositionPda(
            market,
            target.maker.owner,
          ),
          takerPosition: derivePredictionPositionPda(market, owner),
          nextOrder: target.nextOrder ?? program.programId,
          worseLevel: target.worseLevel ?? program.programId,
          levelRentRecipient: target.rentRecipient ?? program.programId,
        })
        .instruction();
      const signature = await (
        program.provider as AnchorProvider
      ).sendAndConfirm(new Transaction().add(ix));
      // A concurrent partial fill can reduce execution after the preview. Only
      // a future transaction-event reader can report its exact confirmed fill.
      onMatched(signature);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Trade failed");
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className="market-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3>Buy or sell now</h3>
      <p>
        Trades with one resting order at its price. Any unfilled request stays
        unposted; submit again to continue.
      </p>
      {!PREDICTION_MATCHING_ENABLED && (
        <p>Trading is awaiting deployment of this program version.</p>
      )}
      <label>
        Outcome
        <select
          value={outcome}
          disabled={pending}
          onChange={(event) => {
            setPreview(null);
            setOutcome(event.target.value as PredictionOutcome);
          }}
        >
          <option value="yes">YES</option>
          <option value="no">NO</option>
        </select>
      </label>
      <label>
        Action
        <select
          value={side}
          disabled={pending}
          onChange={(event) => {
            setPreview(null);
            setSide(event.target.value as OrderSide);
          }}
        >
          <option value="bid">Buy contracts</option>
          <option value="ask">Sell contracts</option>
        </select>
      </label>
      <label>
        {side === "bid" ? "Maximum" : "Minimum"} price per contract ({symbol})
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
        Whole contracts
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
      {loading && <p role="status">Reading the best order and fees…</p>}
      {preview && (
        <p>
          Preview: {preview} Refreshes before signing; execution can change.
        </p>
      )}
      {closed && <p>Trading has closed. You can still cancel open orders.</p>}
      {error && (
        <p className="access-denied" role="alert">
          {error}
        </p>
      )}
      <button
        className="text-button"
        type="button"
        disabled={pending || loading}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh quote
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
          ? "Confirming…"
          : `${side === "bid" ? "Buy" : "Sell"} ${outcome.toUpperCase()}`}
      </button>
    </form>
  );
}
