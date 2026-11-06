"use client";
import { PREDICTION_RESOLUTION_ENABLED } from "../lib/shared";

import { useId, useRef, useState } from "react";
import { BN } from "@anchor-lang/core";
import {
  predictionTime,
  type PredictionMarketAccount,
  type PredictionOrderBookAccount,
} from "../lib/prediction";
import { formatAtomicAmount } from "../lib/tidebook";

/** Read-only help uses the loaded market terms and book; opening it sends no RPC. */
export function PredictionGuide({
  market,
  book,
  symbol = "collateral",
  compact = false,
}: {
  market?: PredictionMarketAccount;
  book?: PredictionOrderBookAccount | null;
  symbol?: string;
  compact?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [outcome, setOutcome] = useState<"yes" | "no">("yes");
  const chosen = outcome.toUpperCase();
  const opposite = outcome === "yes" ? "NO" : "YES";
  const ask = outcome === "yes" ? book?.yesBestAsk : book?.noBestAsk;
  const bid = outcome === "yes" ? book?.yesBestBid : book?.noBestBid;
  const payout = market?.payoutPerContract ?? new BN(1_000_000);
  // Prediction creation fixes one contract's backing to 10^mintDecimals atoms.
  const decimals = payout.toString().length - 1;
  const examplePrice =
    ask ??
    bid ??
    (market && market.priceTick.gtn(0)
      ? payout.divn(2).div(market.priceTick).mul(market.priceTick)
      : new BN(400_000));
  const validExample = examplePrice.gtn(0) && examplePrice.lt(payout);
  const amount = (value: BN) =>
    `${formatAtomicAmount(value, decimals)} ${symbol}`;
  const source = ask
    ? `Current lowest ${chosen} sell offer`
    : bid
      ? `Current highest ${chosen} buy offer`
      : "Illustrative price · not a live quote";
  return (
    <>
      <button
        className="help-trigger"
        type="button"
        onClick={() => dialog.current?.showModal()}
        aria-haspopup="dialog"
        aria-label={compact ? "How predictions work" : undefined}
      >
        <span aria-hidden="true">?</span>
        {!compact && " How predictions work"}
      </button>
      <dialog
        className="prediction-guide"
        ref={dialog}
        aria-labelledby={titleId}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              event.currentTarget.close();
          }
        }}
      >
        <div className="guide-heading">
          <div>
            <span className="eyebrow">A quick guide</span>
            <h2 id={titleId}>
              {market ? "This market, explained" : "From a price to a payout"}
            </h2>
          </div>
          <button
            className="guide-close"
            type="button"
            aria-label="Close prediction guide"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <p>
          YES backs the question happening. NO backs it not happening. Both use
          the same collateral asset.
        </p>
        <div
          className="prediction-tabs"
          role="group"
          aria-label="Example outcome"
        >
          {(["yes", "no"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={outcome === value}
              onClick={() => setOutcome(value)}
            >
              {value.toUpperCase()}
            </button>
          ))}
        </div>
        {market && (
          <p className="guide-market-terms">
            Price step: <strong>{amount(market.priceTick)}</strong> · Winning
            contract: <strong>{amount(payout)}</strong>
          </p>
        )}
        {validExample && (
          <section
            className="guide-example"
            aria-label="Prediction price example"
          >
            <span className="card-label">{source}</span>
            <strong>
              1 {chosen} costs {amount(examplePrice)}
            </strong>
            <div className="guide-outcomes">
              <div>
                <span>If {chosen} wins</span>
                <strong>{amount(payout)} payout</strong>
                <small>
                  {amount(payout.sub(examplePrice))} gain before fees
                </small>
              </div>
              <div>
                <span>If {opposite} wins</span>
                <strong>0 {symbol} payout</strong>
                <small>{amount(examplePrice)} purchase cost lost</small>
              </div>
            </div>
            {!ask && bid && (
              <p>
                This is a buyer’s offer, not an available sell price. A new buy
                order may wait for a seller.
              </p>
            )}
            <p>
              An order must fill first. Offers can change; an unfilled order is
              not a position. Price reflects what traders offer, not a
              guaranteed probability.
            </p>
          </section>
        )}
        <ol className="guide-steps">
          <li>
            <strong>Fund & trade</strong>
            <p>
              Deposit collateral, then buy YES or NO. A seller needs outcome
              contracts: splitting {amount(payout)} creates one YES and one NO.
              Merging a complete pair returns its backing. Buys match sells at
              the resting order’s price; fees reduce your return.
            </p>
          </li>
          <li>
            <strong>Check the rules</strong>
            <p>
              {market
                ? `Trading closes ${predictionTime(market.closeTs)}. Earliest outcome proposal: ${predictionTime(market.earliestResolutionTs ?? market.closeTs)}.`
                : "Every question has a trading cutoff, evidence requirements and a designated resolver. Read its published rules before buying."}
            </p>
            {market && (
              <p>
                Creator / primary resolver:{" "}
                <code>{market.resolver.toBase58()}</code>. Review delay:{" "}
                {market.resolutionDelaySeconds.toString()} seconds.
              </p>
            )}
          </li>
          <li>
            <strong>Resolution & settlement</strong>
            <p>
              The designated active-admin resolver proposes the outcome using
              the published evidence. After review and finalization, the winning
              contract pays {amount(payout)}; the losing contract pays zero. A
              proposed outcome is not final.
            </p>
            <p className="guide-notice">
              {PREDICTION_RESOLUTION_ENABLED
                ? "Finalized outcomes can be redeemed into your shared wallet. Invalid pays half to each outcome. Cancel locked contracts before claiming."
                : "Resolution and claims are implemented behind the next program-upgrade rollout flag."}
            </p>
          </li>
        </ol>
        {market && (
          <section className="guide-fallback">
            <strong>Fallback for this market</strong>
            <p>
              {market.fallback
                ? `Fallback resolver: ${market.fallback.resolver.toBase58()}. Available ${predictionTime(market.fallback.availableTs)}. ${market.fallback.deadlineTs ? `Proposal deadline: ${predictionTime(market.fallback.deadlineTs)}.` : "No proposal deadline is configured."}`
                : "No fallback resolver is configured."}{" "}
              Resolver silence can leave unpaired positions unresolved; do not
              assume an automatic refund.
            </p>
            <p>
              Full criteria and the immutable rules reference are under “Market
              rules & resolution terms”.
            </p>
          </section>
        )}
      </dialog>
    </>
  );
}
