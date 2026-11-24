"use client";
import { BN } from "@anchor-lang/core";
import type { ReactNode } from "react";
import { useI18n } from "../preferences-provider";
import { RulesDocumentDialog } from "../rules-document-dialog";
import {
  predictionCloseLabel,
  predictionReviewLabel,
  rulesDocumentUrl,
} from "../../lib/prediction-display";
import type { MultiMarket } from "../../lib/multi-outcome";

/**
 * The multi-outcome Rules tab in the binary layout: public terms on the left
 * (rules document, payout table, timing), resolution on the right. With up
 * to eight outcomes a payout matrix gets wide, so each row names the winning
 * contracts instead. An Invalid result refunds 1/N on every outcome.
 */
export function MultiOutcomeRules({
  market,
  symbol,
  children,
}: {
  market: MultiMarket;
  symbol: string;
  children: ReactNode;
}) {
  const { t, locale } = useI18n();
  const terms = market.terms,
    labels = terms.outcomeLabels,
    documentUrl = rulesDocumentUrl(terms.rulesUri),
    invalidShare = (1 / labels.length).toFixed(labels.length === 3 ? 4 : 3);
  return (
    <div className="prediction-rules-layout">
      <section
        className="prediction-rule-summary"
        aria-labelledby="multi-rules-heading"
      >
        <div className="prediction-section-title">
          <h2 id="multi-rules-heading">{t("Rules")}</h2>
          {documentUrl && (
            <RulesDocumentDialog
              uri={terms.rulesUri}
              rulesHash={terms.rulesHash}
            />
          )}
        </div>
        {!documentUrl && (
          <p className="shared-address">
            {terms.rulesUri || t("No rules reference available")}
          </p>
        )}
        <table className="prediction-payout-table">
          <caption>
            {t("Payout per contract ({value0})", { value0: symbol })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("Final outcome")}</th>
              <th scope="col">{t("Paid contracts")}</th>
              <th scope="col">{t("Payout")}</th>
            </tr>
          </thead>
          <tbody>
            {labels.map((label) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{label}</td>
                <td>1</td>
              </tr>
            ))}
            <tr>
              <th scope="row">{t("Invalid")}</th>
              <td>{t("Every outcome")}</td>
              <td title={`1/${labels.length}`}>{invalidShare}</td>
            </tr>
          </tbody>
        </table>
        <dl className="prediction-rule-facts">
          <div>
            <dt>{t("Earliest proposal")}</dt>
            <dd>
              {predictionCloseLabel(
                BN.max(
                  terms.closeTs,
                  terms.earliestResolutionTs ?? terms.closeTs,
                ),
                locale,
              )}
            </dd>
          </div>
          <div>
            <dt>{t("Review period")}</dt>
            <dd>
              {predictionReviewLabel(terms.resolutionDelaySeconds, locale)}
            </dd>
          </div>
          {terms.fallback && (
            <div>
              <dt>{t("Fallback available")}</dt>
              <dd>
                {predictionCloseLabel(terms.fallback.availableTs, locale)}
              </dd>
            </div>
          )}
          {terms.fallback?.deadlineTs && (
            <div>
              <dt>{t("Fallback deadline")}</dt>
              <dd>{predictionCloseLabel(terms.fallback.deadlineTs, locale)}</dd>
            </div>
          )}
          <div>
            <dt>{t("Payout destination")}</dt>
            <dd>{t("Outcomia wallet")}</dd>
          </div>
        </dl>
      </section>
      <div className="prediction-resolution-section">{children}</div>
    </div>
  );
}
