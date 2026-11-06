"use client";

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
  if (!market.proposal)
    return <p className="prediction-empty-copy">No outcome proposed.</p>;
  const proposal = market.proposal;
  const evidence = rulesDocumentUrl(proposal.evidenceUri);
  return (
    <div className="prediction-proposal-summary">
      <dl className="prediction-rule-facts">
        <div>
          <dt>Proposed outcome</dt>
          <dd>{Object.keys(proposal.outcome)[0].toUpperCase()}</dd>
        </div>
        <div>
          <dt>Review ends</dt>
          <dd>
            {predictionCloseLabel(
              proposal.proposedAt.add(market.resolutionDelaySeconds),
            )}
          </dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd className="shared-address">
            {evidence ? (
              <a href={evidence} target="_blank" rel="noreferrer">
                Read evidence ↗
              </a>
            ) : (
              proposal.evidenceUri
            )}
          </dd>
        </div>
      </dl>
      <details>
        <summary>Evidence fingerprint</summary>
        <code className="shared-address">
          {Buffer.from(proposal.evidenceHash).toString("hex")}
        </code>
      </details>
    </div>
  );
}
