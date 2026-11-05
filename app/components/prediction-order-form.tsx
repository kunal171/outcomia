"use client";

import { useEffect, useState } from "react";
import { AnchorProvider, BN, type Program } from "@anchor-lang/core";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  derivePredictionBookPda,
  derivePredictionOrderPda,
  derivePredictionPriceLevelPda,
  PREDICTION_ORDERS_ENABLED,
  validatePredictionRestingOrder,
  type PredictionMarketAccount,
  type PredictionOrderBookAccount,
  type PredictionOutcome,
  type PredictionPositionAccount,
} from "../lib/prediction";
import {
  formatAtomicAmount,
  getTidebookAccounts,
  parseTokenAmount,
  type OrderSide,
} from "../lib/tidebook";

interface Props {
  program: Program;
  owner: PublicKey;
  marketAddress: PublicKey;
  market: PredictionMarketAccount;
  positionAddress: PublicKey;
  position: PredictionPositionAccount;
  symbol: string;
  pending: boolean;
  setPending: (pending: boolean) => void;
  onPlaced: (signature: string, order: PublicKey) => void;
}

/** A resting-only first-order form. No UI permission substitutes for chain checks. */
export function PredictionOrderForm({
  program,
  owner,
  marketAddress,
  market,
  positionAddress,
  position,
  symbol,
  pending,
  setPending,
  onPlaced,
}: Props) {
  const [book, setBook] = useState<PredictionOrderBookAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PredictionOutcome>("yes");
  const [side, setSide] = useState<OrderSide>("bid");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setReadError(null);
    getTidebookAccounts(program)
      .predictionOrderBook.fetchNullable(derivePredictionBookPda(marketAddress))
      .then((value) => {
        if (value && !value.market.equals(marketAddress))
          throw new Error("Book belongs to a different market");
        if (!canceled) setBook(value);
      })
      .catch((cause) => {
        if (!canceled)
          setReadError(
            cause instanceof Error ? cause.message : "Unable to read book",
          );
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [program, marketAddress]);
  const decimals = market.payoutPerContract.toString().length - 1;
  function amounts() {
    if (!/^\d+$/.test(quantity.trim()))
      throw new Error("Enter a positive whole contract quantity");
    return {
      price: parseTokenAmount(price, decimals, "Price"),
      quantity: new BN(quantity.trim()),
    };
  }
  let locked: BN | null = null;
  let issue: string | null = null;
  if (book && !loading && !readError && price.trim() && quantity.trim()) {
    try {
      const parsed = amounts();
      locked = validatePredictionRestingOrder(
        market,
        book,
        position,
        outcome,
        side,
        parsed.price,
        parsed.quantity,
        new BN(now),
      );
    } catch (cause) {
      issue = cause instanceof Error ? cause.message : "Invalid order";
    }
  }
  const canSubmit =
    PREDICTION_ORDERS_ENABLED && !!locked && !loading && !readError && !pending;
  async function submit() {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      const accounts = getTidebookAccounts(program);
      // Derive from freshly fetched IDs; stale snapshots still fail atomically
      // if another trader wins the race after this read.
      const [latestBook, latestMarket, latestPosition] = await Promise.all([
        accounts.predictionOrderBook.fetchNullable(
          derivePredictionBookPda(marketAddress),
        ),
        accounts.predictionMarket.fetchNullable(marketAddress),
        accounts.predictionPosition.fetchNullable(positionAddress),
      ]);
      if (!latestBook || !latestMarket || !latestPosition)
        throw new Error("Market, book or position is unavailable; refresh");
      if (
        !latestBook.market.equals(marketAddress) ||
        !latestPosition.market.equals(marketAddress) ||
        !latestPosition.owner.equals(owner)
      )
        throw new Error("Book or position ownership mismatch");
      const parsed = amounts();
      validatePredictionRestingOrder(
        latestMarket,
        latestBook,
        latestPosition,
        outcome,
        side,
        parsed.price,
        parsed.quantity,
        new BN(Math.floor(Date.now() / 1000)),
      );
      const order = derivePredictionOrderPda(
        marketAddress,
        latestBook.nextOrderId,
      );
      const ix = await program.methods
        .placePredictionOrder(
          latestBook.nextOrderId,
          { [outcome]: {} },
          { [side]: {} },
          parsed.price,
          parsed.quantity,
        )
        .accountsStrict({
          owner,
          market: marketAddress,
          position: positionAddress,
          orderBook: derivePredictionBookPda(marketAddress),
          priceLevel: derivePredictionPriceLevelPda(
            marketAddress,
            outcome,
            side,
            parsed.price,
          ),
          order,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const signature = await (
        program.provider as AnchorProvider
      ).sendAndConfirm(new Transaction().add(ix));
      onPlaced(signature, order);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Order placement failed",
      );
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
      <h3>Place a limit order</h3>
      <p>
        First-order testing supports empty sides only. Matching and cancellation
        are not available yet; placed orders keep their funds locked.
      </p>
      {!PREDICTION_ORDERS_ENABLED && (
        <p>Public order submission is disabled until cancellation is ready.</p>
      )}
      {loading && <p>Loading book…</p>}
      {readError && (
        <p className="access-denied" role="alert">
          {readError}
        </p>
      )}
      {!loading && !readError && !book && (
        <p>
          This older draft needs a book root. Create a fresh draft for order
          testing.
        </p>
      )}
      <label>
        Outcome
        <select
          value={outcome}
          disabled={pending}
          onChange={(event) =>
            setOutcome(event.target.value as PredictionOutcome)
          }
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
          onChange={(event) => setSide(event.target.value as OrderSide)}
        >
          <option value="bid">Buy contracts</option>
          <option value="ask">Sell contracts</option>
        </select>
      </label>
      <label>
        Price per contract ({symbol})
        <input
          inputMode="decimal"
          value={price}
          disabled={pending}
          onChange={(event) => setPrice(event.target.value)}
          placeholder="0.60"
        />
      </label>
      <label>
        Whole contracts
        <input
          inputMode="numeric"
          value={quantity}
          disabled={pending}
          onChange={(event) => setQuantity(event.target.value)}
          placeholder="10"
        />
      </label>
      <small>
        {issue ??
          (locked
            ? `Locks ${side === "bid" ? `${formatAtomicAmount(locked, decimals)} ${symbol}` : `${locked.toString()} ${outcome.toUpperCase()} contracts`}. No fee for resting placement.`
            : "Choose a tick-aligned price below 1 and a whole quantity.")}
      </small>
      {error && (
        <p className="access-denied" role="alert">
          {error}
        </p>
      )}
      <button className="primary-button" type="submit" disabled={!canSubmit}>
        {pending
          ? "Confirming…"
          : `${side === "bid" ? "Place buy" : "Place sell"} ${outcome.toUpperCase()}`}
      </button>
    </form>
  );
}
