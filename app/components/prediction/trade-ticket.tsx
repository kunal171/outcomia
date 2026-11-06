"use client";

import { BN } from "@anchor-lang/core";
import type { ReactNode } from "react";
import type { SharedSnapshot, Side } from "../../lib/shared";
import { parseTokenAmount } from "../../lib/tidebook";
import { readableAmount } from "../../lib/market-display";

type Outcome = "yes" | "no";
export interface PredictionTradeTicketProps {
  snapshot: SharedSnapshot | null;
  loaded: boolean;
  failed: boolean;
  pending: boolean;
  disabled: boolean;
  connected: boolean;
  symbol: string;
  decimals: number;
  outcome: Outcome;
  side: Side;
  price: string;
  quantity: string;
  onOutcome: (outcome: Outcome) => void;
  onSide: (side: Side) => void;
  onPrice: (value: string) => void;
  onQuantity: (value: string) => void;
  onSubmit: () => void;
  onInitialize?: () => void;
  feedback: ReactNode;
  funding: ReactNode;
}

/** Controlled ticket: amounts stay in the transaction controller when tabs change.
 * The estimate is a limit value before fees, never an execution or profit promise.
 * Example: 10 contracts at 0.60 cost at most 6 collateral tokens before fees.
 */
export function PredictionTradeTicket(props: PredictionTradeTicketProps) {
  const {
    snapshot,
    loaded,
    pending,
    outcome,
    side,
    price,
    quantity,
    symbol,
    decimals,
  } = props;
  let estimate: { value: BN; payout: BN } | null = null;
  let inputError: string | null = null;
  let errorField: "price" | "quantity" = "price";
  if (snapshot && price && quantity) {
    try {
      const atoms = parseTokenAmount(price, decimals, "Limit price");
      if (atoms.lten(0) || atoms.gte(snapshot.book.payoutPerContract))
        throw new Error(
          `Price must be between 0 and ${readableAmount(snapshot.book.payoutPerContract, decimals)} ${symbol}.`,
        );
      if (
        snapshot.book.priceTick.lten(0) ||
        !atoms.mod(snapshot.book.priceTick).isZero()
      )
        throw new Error(
          `Use price increments of ${readableAmount(snapshot.book.priceTick, decimals)} ${symbol}.`,
        );
      errorField = "quantity";
      if (!/^\d+$/.test(quantity))
        throw new Error("Enter a whole number of contracts.");
      const count = new BN(quantity);
      if (count.lten(0) || count.bitLength() > 64)
        throw new Error(
          "Enter a positive contract count within the supported range.",
        );
      const value = atoms.mul(count);
      if (value.bitLength() > 64)
        throw new Error("Order value exceeds the supported range.");
      estimate = { value, payout: snapshot.book.payoutPerContract.mul(count) };
    } catch (cause) {
      inputError =
        cause instanceof Error
          ? cause.message
          : "Check the price and quantity.";
    }
  }
  const blocked =
    pending ||
    props.disabled ||
    !loaded ||
    !snapshot ||
    !estimate ||
    !!inputError;
  return (
    <section
      className="prediction-ticket"
      aria-labelledby="prediction-ticket-heading"
      data-outcome={outcome}
    >
      <h2 id="prediction-ticket-heading">Place an order</h2>
      <div
        className="prediction-choice"
        role="group"
        aria-label="Choose outcome"
      >
        {(["yes", "no"] as const).map((value) => {
          const offer = snapshot?.book.bestPrices[value === "yes" ? 1 : 3];
          return (
            <button
              type="button"
              key={value}
              data-outcome={value}
              aria-pressed={outcome === value}
              disabled={pending}
              onClick={() => props.onOutcome(value)}
            >
              <span>{value.toUpperCase()}</span>
              <small>
                {!loaded
                  ? props.failed
                    ? "Unavailable"
                    : "Loading…"
                  : offer
                    ? `${readableAmount(offer, decimals)} ${symbol}`
                    : "No sell offers"}
              </small>
            </button>
          );
        })}
      </div>
      {loaded && !snapshot && (
        <div className="prediction-ticket-unavailable">
          {props.onInitialize ? (
            <button
              type="button"
              disabled={pending || props.disabled}
              onClick={props.onInitialize}
            >
              Enable trading
            </button>
          ) : (
            <p>The creator has not enabled trading.</p>
          )}
        </div>
      )}
      {props.connected ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked) props.onSubmit();
          }}
        >
          <div
            className="prediction-action-choice"
            role="group"
            aria-label="Buy or sell"
          >
            {(["bid", "ask"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={side === value}
                disabled={pending}
                onClick={() => props.onSide(value)}
              >
                {value === "bid" ? "Buy" : "Sell"}
              </button>
            ))}
          </div>
          <div className="prediction-entry-fields">
            <label>
              Limit price ({symbol})
              <input
                inputMode="decimal"
                placeholder="0.60"
                value={price}
                disabled={pending || !snapshot}
                onChange={(event) => props.onPrice(event.target.value)}
                aria-invalid={!!inputError && errorField === "price"}
                aria-describedby={
                  inputError ? "prediction-ticket-error" : undefined
                }
              />
            </label>
            <label>
              Contracts
              <input
                inputMode="numeric"
                placeholder="10"
                value={quantity}
                disabled={pending || !snapshot}
                onChange={(event) => props.onQuantity(event.target.value)}
                aria-invalid={!!inputError && errorField === "quantity"}
                aria-describedby={
                  inputError ? "prediction-ticket-error" : undefined
                }
              />
            </label>
          </div>
          {inputError && (
            <p
              className="prediction-field-error"
              id="prediction-ticket-error"
              role="status"
            >
              {inputError}
            </p>
          )}
          <dl className="prediction-order-estimate" aria-live="polite">
            <div>
              <dt>
                Limit value <small>before fees</small>
              </dt>
              <dd>
                {estimate
                  ? `${readableAmount(estimate.value, decimals)} ${symbol}`
                  : "—"}
              </dd>
            </div>
            {side === "bid" && (
              <div>
                <dt>Payout if filled &amp; {outcome.toUpperCase()} wins</dt>
                <dd>
                  {estimate
                    ? `${readableAmount(estimate.payout, decimals)} ${symbol}`
                    : "—"}
                </dd>
              </div>
            )}
          </dl>
          <button
            type="submit"
            className="prediction-submit"
            disabled={blocked}
          >
            {pending
              ? "Confirm in wallet…"
              : `${side === "bid" ? "Buy" : "Sell"} ${outcome.toUpperCase()}`}
          </button>
        </form>
      ) : (
        <p className="prediction-empty-copy">Connect your wallet to trade.</p>
      )}
      {props.feedback}
      {props.connected && props.funding}
    </section>
  );
}
