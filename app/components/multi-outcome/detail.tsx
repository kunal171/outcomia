"use client";
import { TokenSymbol } from "../token-symbol";
import Link from "next/link";
import { PredictionChart } from "../prediction-chart";
import { AppHeader } from "../app-header";
import { transactionExplorerUrl } from "../../lib/outcomia";
import { readableAmount } from "../../lib/market-display";
import {
  MULTI_OUTCOME_ENABLED,
  statusLabel,
  statusOf,
} from "../../lib/multi-outcome";
import { useI18n } from "../preferences-provider";
import { useMultiMarket } from "./use-market";
import { SharedAssetFunds } from "../shared-wallet";
import { MultiTrading } from "./trading";
import { MultiPositions } from "./positions";
import { MultiFees } from "./fees";
import { MultiResolution } from "./resolution";
import "./multi-outcome.css";
export function MultiOutcomeDetail({ address }: { address: string }) {
  const s = useMultiMarket(address),
    d = s.data,
    { t } = useI18n();
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell multi-outcome">
        <Link href="/predictions/multi">← {t("Multi-outcome markets")}</Link>
        <h1 className="multi-detail-title">
          {d?.metadata?.displayName ?? t("Multi-outcome market")}
        </h1>
        {!MULTI_OUTCOME_ENABLED && (
          <p role="status">
            {t(
              "Multi-outcome trading is awaiting deployment verification on devnet.",
            )}
          </p>
        )}
        <button
          onClick={() => void s.refresh()}
          disabled={!MULTI_OUTCOME_ENABLED || s.busy || s.loading}
        >
          {t("Refresh")}
        </button>
        {s.loading && <p role="status">{t("Refreshing market…")}</p>}
        {s.error && <p role="alert">{s.error}</p>}
        {s.signature && (
          <p role="status">
            {t("Confirmed")}:{" "}
            <a
              href={transactionExplorerUrl(s.signature)}
              target="_blank"
              rel="noreferrer"
            >
              {t("View transaction")}
            </a>
          </p>
        )}
        {d && (
          <>
            <p className="multi-actions">
              <span className="ui-badge market-kind-multi">
                {t("Multi-outcome")}
              </span>
              <span
                className="ui-badge market-status-badge"
                data-status={statusOf(d.market)}
              >
                {t(statusLabel(d.market))}
              </span>
              <span>
                {t("Face payout {amount} {symbol}", {
                  amount: readableAmount(
                    d.market.terms.payoutPerContract,
                    d.decimals,
                  ),
                  symbol: "",
                }).trim()}{" "}
                {d.metadata?.quoteSymbol && (
                  <TokenSymbol symbol={d.metadata.quoteSymbol} />
                )}
              </span>
              <span>
                {t("Minimum {count} contracts", {
                  count: d.market.terms.quantityLot.toString(),
                })}
              </span>
            </p>
            <PredictionChart
              market={address}
              engine="MULTI_OUTCOME"
              priceDecimals={d.decimals}
              outcomes={d.market.terms.outcomeLabels}
            />
            <MultiTrading session={s} />
            <details>
              <summary>{t("Deposit or withdraw collateral")}</summary>
              <SharedAssetFunds
                mint={d.market.collateralMint}
                decimals={d.decimals}
                symbol={d.metadata?.quoteSymbol ?? "collateral"}
                onChanged={() => void s.refresh()}
              />
            </details>
            <MultiPositions session={s} />
            <MultiResolution session={s} />
            <MultiFees session={s} />
            <details>
              <summary>{t("Market details")}</summary>
              <p>
                {t("Market")}: <code>{address}</code>
              </p>
              <p>
                {t("Resolver")}:{" "}
                <code>{d.market.terms.resolver.toBase58()}</code>
              </p>
              <p>
                {t("Closes")}:{" "}
                {new Date(
                  d.market.terms.closeTs.toNumber() * 1000,
                ).toLocaleString()}
              </p>
              <p>
                {t("Review delay: {seconds} seconds", {
                  seconds: d.market.terms.resolutionDelaySeconds.toString(),
                })}
              </p>
              <p>
                {t("Reserve")}:{" "}
                {readableAmount(d.market.backingReserve, d.decimals)}
              </p>
            </details>
          </>
        )}
      </main>
    </div>
  );
}
