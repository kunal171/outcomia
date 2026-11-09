"use client";
import { useI18n } from "../preferences-provider";

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
  const { t, locale } = useI18n();

  return (
    <header className="prediction-overview">
      <div className="prediction-overview-top">
        <div className="prediction-market-state">
          <span
            className="role-badge"
            data-live={status === "Open for trading"}
          >
            {status.startsWith("Resolved · ")
              ? t("Resolved · {value0}", {
                  value0: t(status.slice("Resolved · ".length)),
                })
              : t(status)}
          </span>
          <span className="prediction-network">{t("Devnet")}</span>
        </div>
        <div className="prediction-overview-actions">
          <PredictionGuide compact market={market} symbol={symbol} />
          <button
            type="button"
            className="prediction-refresh"
            aria-label={t("Refresh market")}
            title={t("Refresh market")}
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
          <dt>{t("Winning payout")}</dt>
          <dd>
            {`1 ${symbol}`} <span>{t("/ contract")}</span>
          </dd>
        </div>
        <div>
          <dt>{t("Closes")}</dt>
          <dd title={predictionTime(market.closeTs)}>
            {predictionCloseLabel(market.closeTs, locale)}
          </dd>
        </div>
      </dl>
    </header>
  );
}
