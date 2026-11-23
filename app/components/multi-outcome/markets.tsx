"use client";
import { useIndexerUpdates } from "../use-indexer-updates";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { AppHeader } from "../app-header";
import { Pagination, usePage } from "../pagination";
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

/** Every visible multi-outcome market, refreshed on indexer updates.
 * `enabled = false` skips the fetch (e.g. on a binary market's detail page). */
export function useMultiOutcomeMarkets(enabled = true) {
  const { connection } = useConnection();
  const p = useMemo(() => getOutcomiaReadProgram(connection), [connection]);
  const [rows, setRows] = useState<
    { address: string; name: string; market: MultiMarket }[]
  >([]);
  const [error, setError] = useState("");
  const active = MULTI_OUTCOME_ENABLED && enabled;
  const [loading, setLoading] = useState(active);
  const [revision, setRevision] = useState(0);
  useIndexerUpdates(() => setRevision((v) => v + 1));
  useEffect(() => {
    if (!active) return;
    let live = true;
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
        if (live)
          setRows(result.filter((r) => visibleMarket(r.address, r.name)));
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [p, revision, active]);
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
  const paged = usePage(rows, "");
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell multi-outcome">
        <Link className="text-button" href="/predictions">
          {t("← Prediction markets")}
        </Link>
        <header className="ui-page-head multi-list-head" id="multi-list">
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
          {paged.slice.map((r) => (
            <MultiOutcomeCard key={r.address} row={r} />
          ))}
        </div>
        <Pagination
          page={paged.page}
          pages={paged.pages}
          total={paged.total}
          onPage={paged.setPage}
          targetId="multi-list"
        />
      </main>
    </div>
  );
}

/** Whether a multi-outcome market matches the predictions-page search:
 * by name, address or any outcome label. */
export function matchesMultiQuery(row: MultiOutcomeRow, query: string) {
  const needle = query.trim().toLowerCase();
  return (
    !needle ||
    row.name.toLowerCase().includes(needle) ||
    row.address.toLowerCase().includes(needle) ||
    row.market.terms.outcomeLabels.some((l) => l.toLowerCase().includes(needle))
  );
}
