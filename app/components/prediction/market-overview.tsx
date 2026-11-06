"use client";

import type { PredictionMarketAccount } from "../../lib/prediction";
import { predictionTime } from "../../lib/prediction";
import { predictionCloseLabel } from "../../lib/prediction-display";
import { PredictionGuide } from "../prediction-guide";

/** The question leads; status, settlement unit and deadline share one quiet header. */
export function PredictionMarketOverview({
  market,
  name,
  symbol,
  status,
  loading,
  onRefresh,
}: {
  market: PredictionMarketAccount;
  name: string;
  symbol: string;
  status: string;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="prediction-overview">
      <div className="prediction-overview-top">
        <div className="prediction-market-state">
          <span
            className="role-badge"
            data-live={status === "Open for trading"}
          >
            {status}
          </span>
          <span className="prediction-network">Devnet</span>
        </div>
        <div className="prediction-overview-actions">
          <PredictionGuide compact market={market} symbol={symbol} />
          <button
            type="button"
            className="prediction-refresh"
            aria-label="Refresh market"
            title="Refresh market"
            disabled={loading}
            onClick={onRefresh}
          >
            <span
              aria-hidden="true"
              className={loading ? "prediction-refreshing" : undefined}
            >
              ↻
            </span>
          </button>
        </div>
      </div>
      <h1>{name}</h1>
      <dl className="prediction-facts">
        <div>
          <dt>Winning payout</dt>
          <dd>
            1 {symbol} <span>/ contract</span>
          </dd>
        </div>
        <div>
          <dt>Closes</dt>
          <dd title={predictionTime(market.closeTs)}>
            {predictionCloseLabel(market.closeTs)}
          </dd>
        </div>
      </dl>
    </header>
  );
}
