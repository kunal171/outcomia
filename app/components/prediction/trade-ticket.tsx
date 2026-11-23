"use client";
import { useI18n } from "../preferences-provider";

import { BN } from "@anchor-lang/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  bestBuyPrice,
  bestSellPrice,
  type SharedSnapshot,
  type Side,
} from "../../lib/shared";
import { parseTokenAmount } from "../../lib/outcomia";
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

/** Atomic units as a plain decimal string for inputs (no grouping). */
function plainAmount(atoms: BN, decimals: number) {
  const scale = new BN(10).pow(new BN(decimals));
  const whole = atoms.div(scale).toString();
  const fraction = atoms.mod(scale).toString().padStart(decimals, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** Controlled ticket: amounts stay in the transaction controller when tabs change.
 * The estimate is a limit value before fees, never an execution or profit promise.
 * Example: 10 contracts at 0.60 cost at most 6 collateral tokens before fees.
 */
export function PredictionTradeTicket(props: PredictionTradeTicketProps) {
  const { t } = useI18n();

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
  // Exchange-style entry: picking an outcome or side fills the best price
  // once, and either Contracts or Total can be typed; the other follows.
  const [total, setTotal] = useState<string | null>(null);
  const prefilled = useRef<string | null>(null);
  const bestPrice = snapshot
    ? side === "bid"
      ? bestBuyPrice(snapshot.book, outcome)
      : bestSellPrice(snapshot.book, outcome)
    : null;
  useEffect(() => {
    const key = `${outcome}:${side}`;
    if (!bestPrice || prefilled.current === key) return;
    prefilled.current = key;
    const filled = plainAmount(bestPrice, decimals);
    props.onPrice(filled);
    if (total !== null) props.onQuantity(contractsFor(total, filled));
    // Only an outcome or side change triggers a new fill.
  }, [outcome, side, bestPrice?.toString(), decimals]);
  const contractsFor = (amount: string, limit: string) => {
    try {
      const spend = parseTokenAmount(amount, decimals, "Total");
      const each = parseTokenAmount(limit, decimals, "Limit price");
      return each.gtn(0) ? spend.div(each).toString() : "";
    } catch {
      return "";
    }
  };
  let estimate: { value: BN; payout: BN } | null = null;
  let inputError: string | null = null;
  let errorField: "price" | "quantity" = "price";
  if (snapshot && price && quantity) {
    try {
      const atoms = parseTokenAmount(price, decimals, "Limit price");
      if (atoms.lten(0) || atoms.gte(snapshot.book.payoutPerContract))
        throw new Error(
          t("Price must be between 0 and {value0} {value1}.", {
            value0: readableAmount(snapshot.book.payoutPerContract, decimals),
            value1: symbol,
          }),
        );
      if (
        snapshot.book.priceTick.lten(0) ||
        !atoms.mod(snapshot.book.priceTick).isZero()
      )
        throw new Error(
          t("Use price increments of {value0} {value1}.", {
            value0: readableAmount(snapshot.book.priceTick, decimals),
            value1: symbol,
          }),
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
      <h2 id="prediction-ticket-heading">{t("Place an order")}</h2>
      <div
        className="prediction-choice"
        role="group"
        aria-label={t("Choose outcome")}
      >
        {(["yes", "no"] as const).map((value) => {
          const offer = snapshot ? bestBuyPrice(snapshot.book, value) : null;
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
                    ? t("Unavailable")
                    : t("Loading…")
                  : offer
                    ? `${readableAmount(offer, decimals)} ${symbol}`
                    : t("No sell offers")}
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
              {t("Enable trading")}
            </button>
          ) : (
            <p>{t("The creator has not enabled trading.")}</p>
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
            aria-label={t("Buy or sell")}
          >
            {(["bid", "ask"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={side === value}
                disabled={pending}
                onClick={() => props.onSide(value)}
              >
                {value === "bid" ? t("Buy") : t("Sell")}
              </button>
            ))}
          </div>
          <div className="prediction-entry-fields">
            <label>
              {t("Limit price ({value0})", { value0: symbol })}
              <input
                inputMode="decimal"
                placeholder="0.60"
                value={price}
                disabled={pending || !snapshot}
                onChange={(event) => {
                  props.onPrice(event.target.value);
                  if (total !== null)
                    props.onQuantity(contractsFor(total, event.target.value));
                }}
                aria-invalid={!!inputError && errorField === "price"}
                aria-describedby={
                  inputError ? "prediction-ticket-error" : undefined
                }
              />
            </label>
            <label>
              {t("Contracts")}
              <input
                inputMode="numeric"
                placeholder="10"
                value={quantity}
                disabled={pending || !snapshot}
                onChange={(event) => {
                  setTotal(null);
                  props.onQuantity(event.target.value);
                }}
                aria-invalid={!!inputError && errorField === "quantity"}
                aria-describedby={
                  inputError ? "prediction-ticket-error" : undefined
                }
              />
            </label>
            <label className="prediction-total-field">
              {t(
                side === "bid"
                  ? "Total to spend ({value0})"
                  : "Total to receive ({value0})",
                {
                  value0: symbol,
                },
              )}
              <input
                inputMode="decimal"
                placeholder="6"
                value={
                  total ??
                  (estimate ? plainAmount(estimate.value, decimals) : "")
                }
                disabled={pending || !snapshot}
                onChange={(event) => {
                  setTotal(event.target.value);
                  props.onQuantity(contractsFor(event.target.value, price));
                }}
              />
            </label>
          </div>
          {inputError && (
            <p
              className="prediction-field-error"
              id="prediction-ticket-error"
              role="status"
            >
              {t(inputError ?? "")}
            </p>
          )}
          <dl className="prediction-order-estimate" aria-live="polite">
            <div>
              <dt>
                {t("Limit value")} <small>{t("before fees")}</small>
              </dt>
              <dd>
                {estimate
                  ? `${readableAmount(estimate.value, decimals)} ${symbol}`
                  : "—"}
              </dd>
            </div>
            {side === "bid" && (
              <div>
                <dt>
                  {t("Payout if filled & {value0} wins", {
                    value0: outcome.toUpperCase(),
                  })}
                </dt>
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
              ? t("Confirm in wallet…")
              : `${side === "bid" ? t("Buy") : t("Sell")} ${outcome.toUpperCase()}`}
          </button>
        </form>
      ) : (
        <p className="prediction-empty-copy">
          {t("Connect your wallet to trade.")}
        </p>
      )}
      {props.feedback}
      {props.connected && props.funding}
    </section>
  );
}
