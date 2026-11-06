"use client";

import { BN } from "@anchor-lang/core";
import type { ReactNode } from "react";
import type { PredictionMarketAccount } from "../../lib/prediction";
import {
  predictionCloseLabel,
  predictionReviewLabel,
  rulesDocumentUrl,
} from "../../lib/prediction-display";

/** Public terms use a payout table; hashes and addresses live in the references disclosure. */
export function PredictionMarketRules({
  market,
  symbol,
  children,
}: {
  market: PredictionMarketAccount;
  symbol: string;
  children: ReactNode;
}) {
  const documentUrl = rulesDocumentUrl(market.rulesUri);
  return (
    <div className="prediction-rules-layout">
      <section
        className="prediction-rule-summary"
        aria-labelledby="prediction-rules-heading"
      >
        <div className="prediction-section-title">
          <h2 id="prediction-rules-heading">Rules</h2>
          {documentUrl && (
            <a href={documentUrl} target="_blank" rel="noreferrer">
              Published document ↗
            </a>
          )}
        </div>
        {!documentUrl && (
          <p className="shared-address">
            {market.rulesUri || "No rules reference available"}
          </p>
        )}
        <table className="prediction-payout-table">
          <caption>Payout per contract ({symbol})</caption>
          <thead>
            <tr>
              <th scope="col">Final outcome</th>
              <th scope="col">YES</th>
              <th scope="col">NO</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">YES wins</th>
              <td>1</td>
              <td>0</td>
            </tr>
            <tr>
              <th scope="row">NO wins</th>
              <td>0</td>
              <td>1</td>
            </tr>
            <tr>
              <th scope="row">Invalid</th>
              <td>0.5</td>
              <td>0.5</td>
            </tr>
          </tbody>
        </table>
        <dl className="prediction-rule-facts">
          <div>
            <dt>Earliest proposal</dt>
            <dd>
              {predictionCloseLabel(
                BN.max(
                  market.closeTs,
                  market.earliestResolutionTs ?? market.closeTs,
                ),
              )}
            </dd>
          </div>
          <div>
            <dt>Review period</dt>
            <dd>{predictionReviewLabel(market.resolutionDelaySeconds)}</dd>
          </div>
          {market.fallback && (
            <div>
              <dt>Fallback available</dt>
              <dd>{predictionCloseLabel(market.fallback.availableTs)}</dd>
            </div>
          )}
          {market.fallback?.deadlineTs && (
            <div>
              <dt>Fallback deadline</dt>
              <dd>{predictionCloseLabel(market.fallback.deadlineTs)}</dd>
            </div>
          )}
          <div>
            <dt>Payout destination</dt>
            <dd>Tidebook wallet</dd>
          </div>
        </dl>
        {(!market.fallback || !market.fallback.deadlineTs) && (
          <p className="prediction-risk-note">
            Without a timeout deadline, unpaired contracts may stay unresolved.
          </p>
        )}
      </section>
      <div className="prediction-resolution-section">{children}</div>
    </div>
  );
}
