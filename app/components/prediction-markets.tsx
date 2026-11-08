"use client";
import { useI18n } from "./preferences-provider";

import { PREDICTION_RESOLUTION_ENABLED } from "../lib/shared";
import { PredictionDetailLayout } from "./prediction-detail-layout";
import { LegacyRecovery } from "./legacy-recovery";
import { SharedMarket } from "./shared-market";
import { PredictionSettlement } from "./prediction-settlement";

import { useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { PredictionGuide } from "./prediction-guide";
import { AppHeader } from "./app-header";
import { PredictionPositionPanel } from "./prediction-position";
import { PredictionLifecycle } from "./prediction-lifecycle";
import { PredictionBook } from "./prediction-book";
import { useProtocolRole } from "./protocol-role-provider";
import {
  predictionStatus,
  predictionTime,
  type PredictionMarketAccount,
} from "../lib/prediction";
import {
  accountExplorerUrl,
  getTidebookAccounts,
  getTidebookReadProgram,
  type MarketMetadataAccount,
} from "../lib/tidebook";

type Record = {
  address: PublicKey;
  market: PredictionMarketAccount;
  metadata: MarketMetadataAccount | null;
};

/** Public discovery and account inspection; RPC failure never becomes an empty book. */
export function PredictionMarkets({ address }: { address?: string }) {
  const { t } = useI18n();

  const { connection } = useConnection();
  const { role, loading: roleLoading } = useProtocolRole();
  const program = useMemo(
    () => getTidebookReadProgram(connection),
    [connection],
  );
  const [records, setRecords] = useState<Record[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const lastConnection = useRef(connection);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    // Keep the current detail mounted during refresh so forms and confirmations survive.
    const networkChanged = lastConnection.current !== connection;
    lastConnection.current = connection;
    setRecords((current) =>
      networkChanged
        ? []
        : current.filter((row) => row.address.toBase58() === address),
    );
    async function load() {
      try {
        const accounts = getTidebookAccounts(program);
        let markets: Array<{
          publicKey: PublicKey;
          account: PredictionMarketAccount;
        }>;
        if (address) {
          const key = new PublicKey(address);
          const account = await accounts.predictionMarket.fetchNullable(key);
          if (!account)
            throw new Error("Prediction market was not found on this network");
          markets = [{ publicKey: key, account }];
        } else {
          markets = await accounts.predictionMarket.all();
        }
        const rows = await Promise.all(
          markets.map(async ({ publicKey, account }) => {
            // Detail subpanels load their own books only when needed.
            const metadata = await accounts.marketMetadata.fetchNullable(
              account.metadata,
            );
            if (metadata && !metadata.market.equals(publicKey))
              throw new Error("Metadata belongs to a different market");
            return {
              address: publicKey,
              market: account,
              metadata,
            };
          }),
        );
        if (!canceled)
          setRecords(
            rows.sort((a, b) =>
              a.address.toBase58().localeCompare(b.address.toBase58()),
            ),
          );
      } catch (cause) {
        if (!canceled)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load prediction markets",
          );
      } finally {
        if (!canceled) setLoading(false);
      }
    }
    void load();
    return () => {
      canceled = true;
    };
  }, [program, connection, address, refresh]);

  const isAdmin = !roleLoading && (role === "admin" || role === "super-admin");
  const visibleRecords = records.filter(
    (row) =>
      address ||
      `${row.metadata?.displayName ?? ""} ${row.address.toBase58()}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <div className="app-shell">
      <AppHeader />
      <main
        className={
          address ? "route-shell prediction-detail-route" : "route-shell"
        }
      >
        {address && (
          <Link className="text-button" href="/predictions">
            {t("← Prediction markets")}
          </Link>
        )}
        {!address && (
          <div className="route-heading">
            <h1>{t("Prediction markets")}</h1>

            <p className="prediction-release-note">
              {PREDICTION_RESOLUTION_ENABLED
                ? t(
                    "Devnet test markets · Outcome payouts follow each market’s published rules and final resolution.",
                  )
                : t(
                    "Prediction trading is deployed on devnet. Resolution and claims require the next program upgrade.",
                  )}
            </p>
          </div>
        )}
        {!address && (
          <label className="prediction-search">
            {t("Find a market")}
            <input
              type="search"
              placeholder={t("Search questions or market addresses")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}
        {!address && (
          <div className="prediction-help-row">
            <PredictionGuide />
          </div>
        )}
        {!address && (
          <div className="market-list-heading">
            <h2>{t("On-chain markets")}</h2>
            <div className="admin-actions">
              {isAdmin && (
                <Link className="admin-action-button" href="/markets/new">
                  {t("Create market")}
                </Link>
              )}
              <button
                className="text-button"
                type="button"
                disabled={loading}
                onClick={() => setRefresh((value) => value + 1)}
              >
                {t("Refresh")}
              </button>
            </div>
          </div>
        )}
        {loading && records.length === 0 && (
          <div className="access-card">{t("Loading prediction markets…")}</div>
        )}
        {error && (
          <div className="access-card access-denied" role="alert">
            {t(error ?? "")}
          </div>
        )}
        {!loading && !error && records.length === 0 && (
          <div className="access-card">
            {t("No prediction markets exist on this network yet.")}
          </div>
        )}
        {!loading &&
          !error &&
          records.length > 0 &&
          visibleRecords.length === 0 && (
            <div className="access-card">
              {t("No markets match your search.")}
            </div>
          )}
        <section
          className={address ? "prediction-detail-grid" : "markets-grid"}
          aria-live="polite"
        >
          {visibleRecords
            .filter((row) => !address || row.address.toBase58() === address)
            .map(({ address: key, market, metadata }) => {
              const status = predictionStatus(market);
              const decimals = market.payoutPerContract.toString().length - 1;
              const fields = [
                ["Collateral mint", market.collateralMint.toBase58()],
                ["Collateral vault", market.collateralVault.toBase58()],
                ["Creator", market.authority.toBase58()],
                ["Primary resolver", market.resolver.toBase58()],
                ["Trading close", predictionTime(market.closeTs)],
                [
                  "Earliest proposal",
                  predictionTime(market.earliestResolutionTs ?? market.closeTs),
                ],
                [
                  "Review delay",
                  `${market.resolutionDelaySeconds.toString()} seconds`,
                ],
                [
                  "Fallback resolver",
                  market.fallback?.resolver.toBase58() ?? "Not configured",
                ],
                [
                  "Fallback activation",
                  predictionTime(market.fallback?.availableTs ?? null),
                ],
                [
                  "Fallback deadline",
                  predictionTime(market.fallback?.deadlineTs ?? null),
                ],
                [
                  "Winning payout",
                  `1 ${metadata?.quoteSymbol ?? "collateral token"} per contract`,
                ],
                [
                  "Question SHA-256",
                  Buffer.from(market.questionHash).toString("hex"),
                ],
                [
                  "Rules SHA-256",
                  Buffer.from(market.rulesHash).toString("hex"),
                ],
                ["Rules reference", market.rulesUri],
              ];
              if (address)
                return (
                  <PredictionDetailLayout
                    key={`${connection.rpcEndpoint}:${key}`}
                    market={market}
                    metadata={metadata}
                    loading={loading}
                    onRefresh={() => setRefresh((v) => v + 1)}
                    trade={(tradingOpen) => (
                      <SharedMarket
                        market={key}
                        kind="prediction"
                        refreshKey={refresh}
                        view="trade"
                        onChanged={() => setRefresh((v) => v + 1)}
                        entryDisabled={loading || !!error}
                        tradingOpen={tradingOpen}
                        authority={market.authority}
                        quoteMint={market.collateralMint}
                        quoteDecimals={decimals}
                        quoteSymbol={metadata?.quoteSymbol ?? "collateral"}
                      />
                    )}
                    position={
                      <>
                        <PredictionSettlement
                          view="position"
                          address={key}
                          market={market}
                          symbol={metadata?.quoteSymbol ?? "collateral"}
                          onChanged={() => setRefresh((v) => v + 1)}
                        />
                        <SharedMarket
                          market={key}
                          kind="prediction"
                          refreshKey={refresh}
                          view="orders"
                          onChanged={() => setRefresh((v) => v + 1)}
                          tradingOpen={false}
                          authority={market.authority}
                          quoteMint={market.collateralMint}
                          quoteDecimals={decimals}
                          quoteSymbol={metadata?.quoteSymbol ?? "collateral"}
                        />
                        <LegacyRecovery title="Older deposits and orders">
                          <PredictionBook
                            program={program}
                            market={key}
                            decimals={decimals}
                            symbol={metadata?.quoteSymbol ?? "collateral"}
                            revision={String(refresh)}
                          />
                          <PredictionPositionPanel
                            market={key}
                            collateralMint={market.collateralMint}
                            collateralVault={market.collateralVault}
                            status={status}
                            payoutPerContract={market.payoutPerContract}
                            collateralSymbol={
                              metadata?.quoteSymbol ?? "Collateral"
                            }
                            onOrderPlaced={() => {
                              setRefresh((v) => v + 1);
                            }}
                          />
                        </LegacyRecovery>
                      </>
                    }
                    rules={
                      <>
                        <PredictionSettlement
                          view="resolution"
                          address={key}
                          market={market}
                          symbol={metadata?.quoteSymbol ?? "collateral"}
                          onChanged={() => setRefresh((v) => v + 1)}
                        />
                        <details className="admin-card prediction-rules">
                          <summary>
                            {t("Technical details & on-chain references")}
                          </summary>
                          <dl className="market-metadata prediction-terms">
                            {fields.map(([label, value]) => (
                              <div key={label}>
                                <dt>{t(label ?? "")}</dt>
                                <dd>{value}</dd>
                              </div>
                            ))}
                          </dl>
                          <a
                            href={accountExplorerUrl(key)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("View market on Explorer ↗")}
                          </a>
                        </details>
                      </>
                    }
                    manage={
                      <>
                        <PredictionLifecycle
                          address={key}
                          market={market}
                          onOpened={(updated) =>
                            setRecords((current) =>
                              current.map((row) =>
                                row.address.equals(key)
                                  ? { ...row, market: updated }
                                  : row,
                              ),
                            )
                          }
                        />
                        <PredictionSettlement
                          view="manage"
                          address={key}
                          market={market}
                          symbol={metadata?.quoteSymbol ?? "collateral"}
                          onChanged={() => setRefresh((v) => v + 1)}
                        />
                      </>
                    }
                  />
                );
              return (
                <article className="market-card" key={key.toBase58()}>
                  <div className="market-card-heading">
                    <div>
                      <span className="card-label">
                        {t("Prediction · {value0}", { value0: t(status) })}
                      </span>
                      <strong>{metadata?.displayName ?? key.toBase58()}</strong>
                    </div>
                    <span className="role-badge">{t(status ?? "")}</span>
                  </div>
                  <p className="market-address-caption">{key.toBase58()}</p>
                  <p>
                    {t("Trading closes {value0}. Collateral: {value1}.", {
                      value0: predictionTime(market.closeTs),
                      value1:
                        metadata?.quoteSymbol ??
                        market.collateralMint.toBase58(),
                    })}
                  </p>
                  <div className="market-card-actions">
                    {!address && (
                      <Link
                        className="market-open-link"
                        href={`/predictions/${key.toBase58()}`}
                      >
                        {t("View market →")}
                      </Link>
                    )}
                    <a
                      className="market-explorer-link"
                      href={accountExplorerUrl(key)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("View account ↗")}
                    </a>
                  </div>
                </article>
              );
            })}
        </section>
      </main>
    </div>
  );
}
