"use client";
import { useI18n } from "../preferences-provider";

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
  const { t } = useI18n();

  const documentUrl = rulesDocumentUrl(market.rulesUri);
  return (
    <div className="prediction-rules-layout">
      <section
        className="prediction-rule-summary"
        aria-labelledby="prediction-rules-heading"
      >
        <div className="prediction-section-title">
          <h2 id="prediction-rules-heading">{t("Rules")}</h2>
          {documentUrl && (
            <a href={documentUrl} target="_blank" rel="noreferrer">
              {t("Published document ↗")}
            </a>
          )}
        </div>
        {!documentUrl && (
          <p className="shared-address">
            {market.rulesUri || t("No rules reference available")}
          </p>
        )}
        <table className="prediction-payout-table">
          <caption>
            {t("Payout per contract ({value0})", { value0: symbol })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("Final outcome")}</th>
              <th scope="col">{t("YES")}</th>
              <th scope="col">{t("NO")}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">{t("YES wins")}</th>
              <td>1</td>
              <td>0</td>
            </tr>
            <tr>
              <th scope="row">{t("NO wins")}</th>
              <td>0</td>
              <td>1</td>
            </tr>
            <tr>
              <th scope="row">{t("Invalid")}</th>
              <td>0.5</td>
              <td>0.5</td>
            </tr>
          </tbody>
        </table>
        <dl className="prediction-rule-facts">
          <div>
            <dt>{t("Earliest proposal")}</dt>
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
            <dt>{t("Review period")}</dt>
            <dd>{predictionReviewLabel(market.resolutionDelaySeconds)}</dd>
          </div>
          {market.fallback && (
            <div>
              <dt>{t("Fallback available")}</dt>
              <dd>{predictionCloseLabel(market.fallback.availableTs)}</dd>
            </div>
          )}
          {market.fallback?.deadlineTs && (
            <div>
              <dt>{t("Fallback deadline")}</dt>
              <dd>{predictionCloseLabel(market.fallback.deadlineTs)}</dd>
            </div>
          )}
          <div>
            <dt>{t("Payout destination")}</dt>
            <dd>{t("Tidebook wallet")}</dd>
          </div>
        </dl>
        {(!market.fallback || !market.fallback.deadlineTs) && (
          <p className="prediction-risk-note">
            {t(
              "Without a timeout deadline, unpaired contracts may stay unresolved.",
            )}
          </p>
        )}
      </section>
      <div className="prediction-resolution-section">{children}</div>
    </div>
  );
}
