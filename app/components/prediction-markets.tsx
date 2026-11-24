"use client";
import { TokenSymbol } from "./token-symbol";
import { useIndexerUpdates } from "./use-indexer-updates";
import { PredictionChart } from "./prediction-chart";
import { SHARED_BALANCES_ENABLED } from "../lib/shared";
import { useI18n } from "./preferences-provider";
import { visibleMarket } from "../lib/market-visibility";
import {
  clubAccounts,
  clubMarketHref,
  clubMarketPda,
  isClubPredictionMarket,
  isPublicPredictionMarket,
} from "../lib/clubs";

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
import { Pagination, usePage } from "./pagination";
import {
  MultiOutcomeCard,
  matchesMultiQuery,
  useMultiOutcomeMarkets,
} from "./multi-outcome/markets";
import { MULTI_OUTCOME_ENABLED } from "../lib/multi-outcome";
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
  getOutcomiaAccounts,
  getOutcomiaReadProgram,
  type MarketMetadataAccount,
} from "../lib/outcomia";

/** Which market types the predictions list shows. */
type MarketKind = "all" | "binary" | "multi";

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
    () => getOutcomiaReadProgram(connection),
    [connection],
  );
  const [records, setRecords] = useState<Record[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MarketKind>("all");
  const multi = useMultiOutcomeMarkets(!address);
  /** Set when the requested address is a club market, which has its own page. */
  const [clubHref, setClubHref] = useState<string | null>(null);
  const lastConnection = useRef(connection);
  // Live updates refresh in the background: no loading state, and no
  // re-render when nothing changed. A market page listens to its market only.
  const background = useRef(false);
  const shown = useRef("");
  useIndexerUpdates(
    () => {
      background.current = true;
      setRefresh((v) => v + 1);
    },
    address ? [address] : undefined,
  );

  useEffect(() => {
    let canceled = false;
    const quiet = background.current;
    background.current = false;
    const networkChanged = lastConnection.current !== connection;
    lastConnection.current = connection;
    if (!quiet || networkChanged) {
      setLoading(true);
      setError(null);
      shown.current = "";
      // Keep the current detail mounted during refresh so forms and confirmations survive.
      setRecords((current) =>
        networkChanged
          ? []
          : current.filter((row) => row.address.toBase58() === address),
      );
    }
    async function load() {
      if (!quiet) setClubHref(null);
      try {
        const accounts = getOutcomiaAccounts(program);
        let markets: Array<{
          publicKey: PublicKey;
          account: PredictionMarketAccount;
        }>;
        if (address) {
          const key = new PublicKey(address);
          const account = await accounts.predictionMarket.fetchNullable(key);
          if (!account)
            throw new Error("Prediction market was not found on this network");
          if (isClubPredictionMarket(key, account.marketId)) {
            // Club markets trade only through club instructions.
            const binding = await clubAccounts(
              program,
            ).clubMarket.fetchNullable(clubMarketPda(key));
            if (!binding) throw new Error("Club market binding is missing");
            if (!canceled) {
              setClubHref(clubMarketHref(binding.club, key));
              setRecords([]);
            }
            return;
          }
          markets = [{ publicKey: key, account }];
        } else {
          // Club markets share this account type; never list them publicly.
          markets = (await accounts.predictionMarket.all()).filter(
            ({ publicKey, account }) =>
              isPublicPredictionMarket(publicKey, account.marketId),
          );
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
        rows.sort((a, b) =>
          a.address.toBase58().localeCompare(b.address.toBase58()),
        );
        // BN and PublicKey serialize to stable strings, so equal JSON means
        // equal accounts: skip the state update and its re-render.
        const signature = JSON.stringify(rows);
        if (!canceled && signature !== shown.current) {
          shown.current = signature;
          setRecords(rows);
        }
        if (!canceled) setError(null);
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
      (visibleMarket(row.address.toBase58(), row.metadata?.displayName) &&
        `${row.metadata?.displayName ?? ""} ${row.address.toBase58()}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())),
  );
  const visibleMulti = multi.rows.filter((row) =>
    matchesMultiQuery(row, query),
  );
  const shownBinary = kind === "multi" ? [] : visibleRecords;
  const shownMulti = address || kind === "binary" ? [] : visibleMulti;
  const kinds: [MarketKind, string, number][] = [
    ["all", "All markets", visibleRecords.length + visibleMulti.length],
    ["binary", "Binary", visibleRecords.length],
    ["multi", "Multi-outcome", visibleMulti.length],
  ];
  const listLoading =
    (kind !== "multi" && loading && records.length === 0) ||
    (kind !== "binary" && multi.loading && multi.rows.length === 0);
  /** Binary and multi-outcome markets in one list, soonest close first. */
  const listed = [
    ...shownBinary
      .filter((row) => !address || row.address.toBase58() === address)
      .map((binary) => ({
        close: binary.market.closeTs.toNumber(),
        binary,
        multi: null,
      })),
    ...shownMulti.map((multi) => ({
      close: multi.market.terms.closeTs.toNumber(),
      binary: null as never,
      multi,
    })),
  ].sort((a, b) => a.close - b.close);
  const paged = usePage(listed, `${query}|${kind}`);
  const renderBinary = ({ address: key, market, metadata }: Record) => {
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
      ["Review delay", `${market.resolutionDelaySeconds.toString()} seconds`],
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
      ["Question SHA-256", Buffer.from(market.questionHash).toString("hex")],
      ["Rules SHA-256", Buffer.from(market.rulesHash).toString("hex")],
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
            <>
              <PredictionChart
                market={key.toBase58()}
                engine={
                  SHARED_BALANCES_ENABLED ? "SHARED_BINARY" : "LEGACY_BINARY"
                }
                priceDecimals={decimals}
                outcomes={["YES", "NO"]}
                binary
              />
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
            </>
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
                  collateralSymbol={metadata?.quoteSymbol ?? "Collateral"}
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
            <div className="multi-market-badges">
              <span className="ui-badge market-kind-binary">{t("Binary")}</span>
              <span
                className="ui-badge market-status-badge"
                data-status={status}
              >
                {t(status ?? "")}
              </span>
            </div>
            <strong>{metadata?.displayName ?? key.toBase58()}</strong>
          </div>
        </div>
        <p className="market-address-caption">{key.toBase58()}</p>
        <p className="market-card-terms">
          {t("Trading closes {value0}.", {
            value0: predictionTime(market.closeTs),
          })}{" "}
          <TokenSymbol
            symbol={metadata?.quoteSymbol ?? market.collateralMint.toBase58()}
          />
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
  };
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
        {clubHref && (
          <div className="ui-empty club-redirect">
            <p>{t("This market belongs to a club.")}</p>
            <Link className="ui-btn ui-btn-primary" href={clubHref}>
              {t("Open in club →")}
            </Link>
          </div>
        )}
        {!address && (
          <div className="route-heading prediction-hero">
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
          <div className="market-list-heading" id="market-list">
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
        {!address && MULTI_OUTCOME_ENABLED && (
          <div
            className="market-type-filter"
            role="group"
            aria-label={t("Market type")}
          >
            {kinds.map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
              >
                {t(label)}
                <span className="market-type-count">{count}</span>
              </button>
            ))}
          </div>
        )}
        {listLoading && (
          <div className="access-card">{t("Loading prediction markets…")}</div>
        )}
        {error && kind !== "multi" && (
          <div className="access-card access-denied" role="alert">
            {t(error ?? "")}
          </div>
        )}
        {multi.error && !address && kind !== "binary" && (
          <div className="access-card access-denied" role="alert">
            {multi.error}
          </div>
        )}
        {!loading &&
          !error &&
          !clubHref &&
          records.length === 0 &&
          (address || kind === "binary") && (
            <div className="access-card">
              {t("No prediction markets exist on this network yet.")}
            </div>
          )}
        {!address &&
          !listLoading &&
          !error &&
          shownBinary.length + shownMulti.length === 0 &&
          (query.trim() !== "" || kind !== "binary") && (
            <div className="access-card">
              {t("No markets match your search.")}
            </div>
          )}
        <section
          className={address ? "prediction-detail-grid" : "markets-grid"}
          aria-live="polite"
        >
          {paged.slice.map((item) =>
            item.multi ? (
              <MultiOutcomeCard key={item.multi.address} row={item.multi} />
            ) : (
              renderBinary(item.binary)
            ),
          )}
        </section>
        {!address && (
          <Pagination
            page={paged.page}
            pages={paged.pages}
            total={paged.total}
            onPage={paged.setPage}
            targetId="market-list"
          />
        )}
      </main>
    </div>
  );
}
