"use client";
import { useIndexerUpdates } from "../use-indexer-updates";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { getOutcomiaReadProgram } from "../../lib/outcomia";
import { MULTI_OUTCOME_ENABLED, sideOf } from "../../lib/multi-outcome";
import { readableAmount } from "../../lib/market-display";
import {
  loadMultiWallet,
  type MultiWalletMarket,
} from "../../lib/multi-outcome-wallet";
export function MultiWalletActivity({
  mode,
}: {
  mode: "positions" | "orders";
}) {
  const { connection } = useConnection(),
    wallet = useAnchorWallet();
  const p = useMemo(() => getOutcomiaReadProgram(connection), [connection]);
  const identity = `${connection.rpcEndpoint}:${wallet?.publicKey.toBase58() ?? ""}`;
  const [result, setResult] = useState<{
      identity: string;
      rows: MultiWalletMarket[];
    } | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(false),
    [history, setHistory] = useState(false);
  useIndexerUpdates(() => setRevision((v) => v + 1));
  useEffect(() => {
    let active = true;
    setResult(null);
    setError("");
    if (!MULTI_OUTCOME_ENABLED || !wallet) return;
    setLoading(true);
    void loadMultiWallet(p, wallet.publicKey, mode)
      .then((rows) => {
        if (active) setResult({ identity, rows });
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [p, identity, mode, revision, wallet]);
  if (!MULTI_OUTCOME_ENABLED || !wallet) return null;
  const rows = result?.identity === identity ? result.rows : [];
  return (
    <section className="admin-card" aria-labelledby={`multi-wallet-${mode}`}>
      <h2 id={`multi-wallet-${mode}`}>Multi-outcome {mode}</h2>
      <button disabled={loading} onClick={() => setRevision((v) => v + 1)}>
        Refresh multi-outcome {mode}
      </button>
      {mode === "orders" && (
        <label>
          <input
            type="checkbox"
            checked={history}
            onChange={(e) => setHistory(e.target.checked)}
          />
          Include filled and canceled orders
        </label>
      )}
      {loading && <p role="status">Loading multi-outcome {mode}…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <p>No multi-outcome {mode} yet.</p>
      )}
      {rows.map((r) => (
        <article key={r.key.toBase58()}>
          <h3>
            <Link href={`/predictions/multi/${r.key.toBase58()}`}>
              {r.name}
            </Link>
          </h3>
          {mode === "positions" && r.position && (
            <div className="prediction-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Outcome</th>
                    <th>Available contracts</th>
                    <th>Locked contracts</th>
                  </tr>
                </thead>
                <tbody>
                  {r.market.terms.outcomeLabels.map((label, i) => (
                    <tr key={i}>
                      <th>{label}</th>
                      <td>{r.position!.free[i].toString()}</td>
                      <td>{r.position!.locked[i].toString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {mode === "orders" && (
            <div className="prediction-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Outcome</th>
                    <th>Side</th>
                    <th>Price ({r.symbol})</th>
                    <th>Remaining</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {r.orders
                    .filter((o) => history || "open" in o.account.status)
                    .map((o) => (
                      <tr key={o.publicKey.toBase58()}>
                        <td>
                          {r.market.terms.outcomeLabels[o.account.outcome[0]]}
                        </td>
                        <td>{sideOf(o.account) === "bid" ? "Buy" : "Sell"}</td>
                        <td>{readableAmount(o.account.price, r.decimals)}</td>
                        <td>{o.account.remainingQuantity.toString()}</td>
                        <td>{Object.keys(o.account.status)[0]}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          <Link
            href={`/predictions/multi/${r.key.toBase58()}#${mode === "positions" ? "multi-positions" : "multi-trade"}`}
          >
            Manage {mode} in market →
          </Link>
        </article>
      ))}
    </section>
  );
}
