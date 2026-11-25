"use client";
import { TokenSymbol } from "../token-symbol";
import Link from "next/link";
import { PredictionChart } from "../prediction-chart";
import { AppHeader } from "../app-header";
import { readableAmount } from "../../lib/market-display";
import {
  MULTI_OUTCOME_ENABLED,
  statusLabel,
  statusOf,
} from "../../lib/multi-outcome";
import { useI18n } from "../preferences-provider";
import { useMultiMarket } from "./use-market";
import { SharedAssetFunds } from "../shared-wallet";
import { MarketTraders } from "../social/market-traders";
import { MultiTrading } from "./trading";
import { MultiPositions } from "./positions";
import { MultiFees } from "./fees";
import { MultiResolution } from "./resolution";
import { MultiOutcomeRules } from "./rules";
import { useMarketClock } from "./use-clock";
import { PredictionMarketOverview } from "../prediction/market-overview";
import { MarketTabs } from "../market-tabs";
import { TransactionToast } from "../transaction-toast";
import { useProtocolRole } from "../protocol-role-provider";
import "./multi-outcome.css";
export function MultiOutcomeDetail({ address }: { address: string }) {
  const s = useMultiMarket(address),
    d = s.data,
    { t } = useI18n(),
    now = useMarketClock(),
    { role } = useProtocolRole();
  const symbol = d?.metadata?.quoteSymbol ?? "collateral";
  // Same status wording as binary markets.
  const status = !d
    ? ""
    : statusOf(d.market) === "open"
      ? now < d.market.terms.closeTs.toNumber()
        ? "Open for trading"
        : "Trading closed"
      : statusLabel(d.market);
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell prediction-detail-route">
        <Link className="text-button" href="/predictions">
          {t("← Prediction markets")}
        </Link>
        {!MULTI_OUTCOME_ENABLED && (
          <p role="status">
            {t(
              "Multi-outcome trading is awaiting deployment verification on devnet.",
            )}
          </p>
        )}
        {s.error && (
          <div className="access-card access-denied" role="alert">
            <p>{s.error}</p>
            {/* Without a loaded market there is no header refresh: retry here. */}
            {!d && (
              <button
                type="button"
                className="ui-btn"
                aria-label={t("Refresh market")}
                disabled={s.loading || !MULTI_OUTCOME_ENABLED}
                onClick={() => void s.refresh()}
              >
                {t("Refresh")}
              </button>
            )}
          </div>
        )}
        {!d && s.loading && (
          <div className="access-card">{t("Loading market…")}</div>
        )}
        {d && (
          <div className="prediction-workspace">
            <PredictionMarketOverview
              closeTs={d.market.terms.closeTs}
              name={d.metadata?.displayName ?? t("Multi-outcome market")}
              symbol={symbol}
              status={status}
              tag="Multi-outcome"
              loading={s.loading || !MULTI_OUTCOME_ENABLED}
              onRefresh={() => void s.refresh()}
              facts={[
                {
                  label: "Outcomes",
                  value: String(d.market.terms.outcomeLabels.length),
                },
                {
                  label: "Minimum order",
                  value: t("{count} contracts", {
                    count: d.market.terms.quantityLot.toString(),
                  }),
                },
              ]}
            />
            <MarketTabs
              initial={statusOf(d.market) === "resolved" ? "position" : "trade"}
              tabs={[
                {
                  id: "trade",
                  label: "Trade",
                  content: (
                    <>
                      <PredictionChart
                        market={address}
                        engine="MULTI_OUTCOME"
                        priceDecimals={d.decimals}
                        outcomes={d.market.terms.outcomeLabels}
                      />
                      <div className="multi-outcome">
                        <MultiTrading session={s} />
                        <details id="multi-funds">
                          <summary>
                            {t("Deposit or withdraw collateral")}
                          </summary>
                          <SharedAssetFunds
                            mint={d.market.collateralMint}
                            decimals={d.decimals}
                            symbol={symbol}
                            onChanged={() => void s.refresh()}
                          />
                        </details>
                      </div>
                    </>
                  ),
                },
                {
                  id: "position",
                  label: "Your position",
                  content: (
                    <>
                      <div className="prediction-position-intro">
                        <Link className="text-button" href="/wallet">
                          {t("Wallet →")}
                        </Link>
                      </div>
                      <div className="multi-outcome">
                        <MultiPositions session={s} />
                      </div>
                    </>
                  ),
                },
                {
                  id: "rules",
                  label: "Rules & outcome",
                  content: (
                    <MultiOutcomeRules market={d.market} symbol={symbol}>
                      <div className="multi-outcome multi-resolution-column">
                        <MultiResolution session={s} />
                        <details className="multi-technical">
                          <summary>
                            {t("Technical details & on-chain references")}
                          </summary>
                          <dl>
                            <dt>{t("Market")}</dt>
                            <dd>
                              <code>{address}</code>
                            </dd>
                            <dt>{t("Resolver")}</dt>
                            <dd>
                              <code>{d.market.terms.resolver.toBase58()}</code>
                            </dd>
                            <dt>{t("Rules SHA-256")}</dt>
                            <dd>
                              <code>
                                {Buffer.from(d.market.terms.rulesHash).toString(
                                  "hex",
                                )}
                              </code>
                            </dd>
                            <dt>{t("Reserve")}</dt>
                            <dd>
                              {readableAmount(
                                d.market.backingReserve,
                                d.decimals,
                              )}{" "}
                              <TokenSymbol symbol={symbol} />
                            </dd>
                          </dl>
                        </details>
                      </div>
                    </MultiOutcomeRules>
                  ),
                },
                {
                  id: "traders",
                  label: "Top traders",
                  content: (
                    <MarketTraders
                      market={address}
                      decimals={d.decimals}
                      symbol={symbol}
                    />
                  ),
                },
                // Fee withdrawal is the only market administration here and
                // only the super-admin can do it, as on binary markets.
                ...(role === "super-admin"
                  ? [
                      {
                        id: "manage",
                        label: "Manage market",
                        content: (
                          <div className="multi-outcome">
                            <MultiFees session={s} />
                          </div>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        )}
        <TransactionToast signature={s.signature ?? null} />
      </main>
    </div>
  );
}
