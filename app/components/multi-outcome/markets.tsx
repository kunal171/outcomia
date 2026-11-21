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
  statusOf,
  type MultiMarket,
} from "../../lib/multi-outcome";
import { visibleMarket } from "../../lib/market-visibility";
import "./multi-outcome.css";

export function MultiOutcomeMarkets() {
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
          setRows(
            result.filter((r) => visibleMarket(r.address, r.name)),
          );
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
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell multi-outcome">
        <Link href="/predictions">← Binary prediction markets</Link>
        <div className="route-heading">
          <h1>Multi-outcome markets</h1>
          <p>
            2–8 named outcomes. One winner. One collateral token backs each
            complete set.
          </p>
        </div>
        <div className="multi-actions">
          <Link href="/predictions/multi/new">Create a market</Link>
          <button
            onClick={() => setRevision((v) => v + 1)}
            disabled={loading || !MULTI_OUTCOME_ENABLED}
          >
            Refresh
          </button>
        </div>
        {!MULTI_OUTCOME_ENABLED && (
          <p role="status">
            Multi-outcome trading is awaiting deployment verification on devnet.
            Creation and trading are disabled.
          </p>
        )}
        {loading && <p role="status">Loading markets…</p>}
        {error && <p role="alert">{error}</p>}
        {!loading && !error && MULTI_OUTCOME_ENABLED && rows.length === 0 && (
          <p>No multi-outcome markets found.</p>
        )}
        <div className="multi-grid">
          {rows.map((r) => (
            <Link
              className="multi-card"
              key={r.address}
              href={`/predictions/multi/${r.address}`}
            >
              <h2>{r.name}</h2>
              <p>{r.market.terms.outcomeLabels.join(" · ")}</p>
              <p>
                {statusOf(r.market)} · Minimum{" "}
                {r.market.terms.quantityLot.toString()} contracts
              </p>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
