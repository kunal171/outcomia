"use client";
import { useIndexerUpdates } from "../use-indexer-updates";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { AppHeader } from "../app-header";
import {
  getOutcomiaAccounts,
  getOutcomiaReadProgram,
} from "../../lib/outcomia";
import {
  MULTI_OUTCOME_ENABLED,
  multiAccounts,
  multiMarketPda,
  statusLabel,
  type MultiMarket,
} from "../../lib/multi-outcome";
import { visibleMarket } from "../../lib/market-visibility";
import { useI18n } from "../preferences-provider";
import "./multi-outcome.css";

/** Every visible multi-outcome market, refreshed on indexer updates. */
export function useMultiOutcomeMarkets() {
  const { connection } = useConnection();
  const p = useMemo(() => getOutcomiaReadProgram(connection), [connection]);
  const [rows, setRows] = useState<
    { address: string; name: string; market: MultiMarket }[]
  >([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(MULTI_OUTCOME_ENABLED);
  const [revision, setRevision] = useState(0);
  useIndexerUpdates(() => setRevision((v) => v + 1));
  useEffect(() => {
    if (!MULTI_OUTCOME_ENABLED) return;
    let active = true;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const records = await multiAccounts(p).multiOutcomeMarket.all();
        const result = await Promise.all(
          records.map(async (r) => {
            if (
              !multiMarketPda(Uint8Array.from(r.account.marketId)).equals(
                r.publicKey,
              )
            )
              throw new Error("Invalid market identity.");
            const metadata = await getOutcomiaAccounts(
              p,
            ).marketMetadata.fetchNullable(r.account.metadata);
            if (metadata && !metadata.market.equals(r.publicKey))
              throw new Error("Invalid market metadata.");
            return {
              address: r.publicKey.toBase58(),
              name: metadata?.displayName ?? r.publicKey.toBase58(),
              market: r.account,
            };
          }),
        );
        if (active)
          setRows(result.filter((r) => visibleMarket(r.address, r.name)));
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [p, revision]);
  return {
    rows,
    error,
    loading,
    refresh: () => setRevision((v) => v + 1),
  };
}

export type MultiOutcomeRow = ReturnType<
  typeof useMultiOutcomeMarkets
>["rows"][number];

/** A multi-outcome market in a list, tagged so it reads apart from binary
 * markets wherever both appear. */
export function MultiOutcomeCard({ row }: { row: MultiOutcomeRow }) {
  const { t } = useI18n();
  const labels = row.market.terms.outcomeLabels;
  return (
    <Link
      className="ui-card multi-market-card"
      href={`/predictions/multi/${row.address}`}
    >
      <div className="multi-market-badges">
        <span className="ui-badge ui-badge-accent">{t("Multi-outcome")}</span>
        <span className="ui-badge">{t(statusLabel(row.market))}</span>
      </div>
      <h3>{row.name}</h3>
      <ul className="multi-market-outcomes" aria-label={t("Outcomes")}>
        {labels.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
      <div className="multi-market-foot">
        <span>{t("{count} outcomes", { count: String(labels.length) })}</span>
        <span className="multi-market-open">{t("View market →")}</span>
      </div>
    </Link>
  );
}

export function MultiOutcomeMarkets() {
  const { t } = useI18n();
  const { rows, error, loading, refresh } = useMultiOutcomeMarkets();
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell multi-outcome">
        <Link className="text-button" href="/predictions">
          ← {t("Binary prediction markets")}
        </Link>
        <header className="ui-page-head multi-list-head">
          <div>
            <p className="ui-eyebrow">{t("Multi-outcome")}</p>
            <h1 className="ui-title">{t("Multi-outcome markets")}</h1>
            <p className="ui-lead">
              {t(
                "2–8 named outcomes. One winner. One collateral token backs each complete set.",
              )}
            </p>
          </div>
          <div className="ui-actions">
            <button
              type="button"
              className="ui-btn"
              onClick={refresh}
              disabled={loading || !MULTI_OUTCOME_ENABLED}
            >
              {t("Refresh")}
            </button>
            <Link
              className="ui-btn ui-btn-primary"
              href="/predictions/multi/new"
            >
              {t("Create a market")}
            </Link>
          </div>
        </header>
        {!MULTI_OUTCOME_ENABLED && (
          <p role="status">
            {t(
              "Multi-outcome trading is awaiting deployment verification on devnet. Creation and trading are disabled.",
            )}
          </p>
        )}
        {loading && <p role="status">{t("Loading markets…")}</p>}
        {error && <p role="alert">{error}</p>}
        {!loading && !error && MULTI_OUTCOME_ENABLED && rows.length === 0 && (
          <p>{t("No multi-outcome markets found.")}</p>
        )}
        <div className="ui-grid multi-market-grid">
          {rows.map((r) => (
            <MultiOutcomeCard key={r.address} row={r} />
          ))}
        </div>
      </main>
    </div>
  );
}

/** Multi-outcome markets on the main predictions list, filtered by the same
 * search as the binary markets below them. */
/** Cards shown on the main list before "View all". */
const SHELF_LIMIT = 6;

export function MultiOutcomeShelf({ query }: { query: string }) {
  const { t } = useI18n();
  const { rows, loading } = useMultiOutcomeMarkets();
  if (!MULTI_OUTCOME_ENABLED) return null;
  const needle = query.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      !needle ||
      r.name.toLowerCase().includes(needle) ||
      r.address.toLowerCase().includes(needle) ||
      r.market.terms.outcomeLabels.some((l) =>
        l.toLowerCase().includes(needle),
      ),
  );
  if (!loading && shown.length === 0) return null;
  return (
    <section className="ui-section multi-market-shelf">
      <div className="ui-section-head">
        <h2>{t("Multi-outcome markets")}</h2>
        <Link className="text-button" href="/predictions/multi">
          {t("View all →")}
        </Link>
      </div>
      {loading && rows.length === 0 ? (
        <p role="status">{t("Loading markets…")}</p>
      ) : (
        <div className="ui-grid multi-market-grid">
          {shown.slice(0, SHELF_LIMIT).map((r) => (
            <MultiOutcomeCard key={r.address} row={r} />
          ))}
        </div>
      )}
    </section>
  );
}
