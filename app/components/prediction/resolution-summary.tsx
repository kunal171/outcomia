"use client";
import { useI18n } from "../preferences-provider";

import type { PredictionMarketAccount } from "../../lib/prediction";
import {
  predictionCloseLabel,
  rulesDocumentUrl,
} from "../../lib/prediction-display";

/** Evidence is public; its full fingerprint is secondary to the outcome and review date. */
export function PredictionResolutionSummary({
  market,
}: {
  market: PredictionMarketAccount;
}) {
  const { t } = useI18n();

  if (!market.proposal)
    return <p className="prediction-empty-copy">{t("No outcome proposed.")}</p>;
  const proposal = market.proposal;
  const evidence = rulesDocumentUrl(proposal.evidenceUri);
  return (
    <div className="prediction-proposal-summary">
      <dl className="prediction-rule-facts">
        <div>
          <dt>{t("Proposed outcome")}</dt>
          <dd>{t(Object.keys(proposal.outcome)[0].toUpperCase() ?? "")}</dd>
        </div>
        <div>
          <dt>{t("Review ends")}</dt>
          <dd>
            {predictionCloseLabel(
              proposal.proposedAt.add(market.resolutionDelaySeconds),
            )}
          </dd>
        </div>
        <div>
          <dt>{t("Evidence")}</dt>
          <dd className="shared-address">
            {evidence ? (
              <a href={evidence} target="_blank" rel="noreferrer">
                {t("Read evidence ↗")}
              </a>
            ) : (
              proposal.evidenceUri
            )}
          </dd>
        </div>
      </dl>
      <details>
        <summary>{t("Evidence fingerprint")}</summary>
        <code className="shared-address">
          {Buffer.from(proposal.evidenceHash).toString("hex")}
        </code>
      </details>
    </div>
  );
}
