"use client";
import { useI18n } from "./preferences-provider";

import { PREDICTION_RESOLUTION_ENABLED } from "../lib/shared";

import { useId, useRef, useState } from "react";
import { BN } from "@anchor-lang/core";
import {
  predictionTime,
  type PredictionMarketAccount,
  type PredictionOrderBookAccount,
} from "../lib/prediction";
import { formatAtomicAmount } from "../lib/outcomia";

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
  const { t } = useI18n();

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
    ? t("Current lowest {value0} sell offer", { value0: chosen })
    : bid
      ? t("Current highest {value0} buy offer", { value0: chosen })
      : "Illustrative price · not a live quote";
  return (
    <>
      <button
        className="help-trigger"
        type="button"
        onClick={() => dialog.current?.showModal()}
        aria-haspopup="dialog"
        aria-label={compact ? t("How predictions work") : undefined}
      >
        <span aria-hidden="true">?</span>
        {!compact && t(" How predictions work")}
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
            <h2 id={titleId}>
              {market
                ? t("This market, explained")
                : t("From a price to a payout")}
            </h2>
          </div>
          <button
            className="guide-close"
            type="button"
            aria-label={t("Close prediction guide")}
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <p>
          {t(
            "YES backs the question happening. NO backs it not happening. Both use the same collateral asset.",
          )}
        </p>
        <div
          className="prediction-tabs"
          role="group"
          aria-label={t("Example outcome")}
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
            {t("Price step:")} <strong>{amount(market.priceTick)}</strong>{" "}
            {t("· Winning contract:")} <strong>{amount(payout)}</strong>
          </p>
        )}
        {validExample && (
          <section
            className="guide-example"
            aria-label={t("Prediction price example")}
          >
            <span className="card-label">{t(source ?? "")}</span>
            <strong>
              {t("1 {value0} costs {value1}", {
                value0: chosen,
                value1: amount(examplePrice),
              })}
            </strong>
            <div className="guide-outcomes">
              <div>
                <span>{t("If {value0} wins", { value0: chosen })}</span>
                <strong>
                  {t("{value0} payout", { value0: amount(payout) })}
                </strong>
                <small>
                  {t("{value0} gain before fees", {
                    value0: amount(payout.sub(examplePrice)),
                  })}
                </small>
              </div>
              <div>
                <span>{t("If {value0} wins", { value0: opposite })}</span>
                <strong>{t("0 {value0} payout", { value0: symbol })}</strong>
                <small>
                  {t("{value0} purchase cost lost", {
                    value0: amount(examplePrice),
                  })}
                </small>
              </div>
            </div>
            {!ask && bid && (
              <p>
                {t(
                  "This is a buyer’s offer, not an available sell price. A new buy order may wait for a seller.",
                )}
              </p>
            )}
            <p>
              {t(
                "Unfilled orders are not positions. Prices are offers, not guaranteed probabilities.",
              )}
            </p>
          </section>
        )}
        <ol className="guide-steps">
          <li>
            <strong>{t("Fund & trade")}</strong>
            <p>
              {t(
                "Deposit collateral, then buy YES or NO. A seller needs outcome contracts: splitting {value0} creates one YES and one NO. Merging a complete pair returns its backing. Buys match sells at the resting order’s price; fees reduce your return.",
                { value0: amount(payout) },
              )}
            </p>
          </li>
          <li>
            <strong>{t("Check the rules")}</strong>
            <p>
              {market
                ? t(
                    "Trading closes {value0}. Earliest outcome proposal: {value1}.",
                    {
                      value0: predictionTime(market.closeTs),
                      value1: predictionTime(
                        market.earliestResolutionTs ?? market.closeTs,
                      ),
                    },
                  )
                : t(
                    "Every question has a trading cutoff, evidence requirements and a designated resolver. Read its published rules before buying.",
                  )}
            </p>
            {market && (
              <p>
                {t("Creator / primary resolver:")}{" "}
                <code>{market.resolver.toBase58()}</code>
                {t(". Review delay: {value0} seconds.", {
                  value0: market.resolutionDelaySeconds.toString(),
                })}
              </p>
            )}
          </li>
          <li>
            <strong>{t("Resolution & settlement")}</strong>
            <p>
              {t(
                "The designated active-admin resolver proposes the outcome using the published evidence. After review and finalization, the winning contract pays {value0}; the losing contract pays zero. A proposed outcome is not final.",
                { value0: amount(payout) },
              )}
            </p>
            <p className="guide-notice">
              {PREDICTION_RESOLUTION_ENABLED
                ? t(
                    "Finalized outcomes can be redeemed into your shared wallet. Invalid pays half to each outcome. Cancel locked contracts before claiming.",
                  )
                : t(
                    "Resolution and claims are implemented behind the next program-upgrade rollout flag.",
                  )}
            </p>
          </li>
        </ol>
        {market && (
          <section className="guide-fallback">
            <strong>{t("Fallback for this market")}</strong>
            <p>
              {t(
                "{value0} Resolver silence can leave unpaired positions unresolved; do not assume an automatic refund.",
                {
                  value0: market.fallback
                    ? t(
                        "Fallback resolver: {value0}. Available {value1}. {value2}",
                        {
                          value0: market.fallback.resolver.toBase58(),
                          value1: predictionTime(market.fallback.availableTs),
                          value2: market.fallback.deadlineTs
                            ? t("Proposal deadline: {value0}.", {
                                value0: predictionTime(
                                  market.fallback.deadlineTs,
                                ),
                              })
                            : t("No proposal deadline is configured."),
                        },
                      )
                    : t("No fallback resolver is configured."),
                },
              )}
            </p>
            <p>{t("Read the published rules in Rules & outcome.")}</p>
          </section>
        )}
      </dialog>
    </>
  );
}
