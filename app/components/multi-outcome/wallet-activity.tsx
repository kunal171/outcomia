"use client";
/** Multi-outcome holdings on the wallet and orders pages, styled like the
 * binary sections next to them. Only markets where the wallet holds contracts
 * (positions) or has orders in the selected view (orders) are listed, so empty
 * positions and finished test markets do not clutter either page. */
import { useIndexerUpdates } from "../use-indexer-updates";
import { useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { useI18n } from "../preferences-provider";
import { getOutcomiaReadProgram } from "../../lib/outcomia";
import { MULTI_OUTCOME_ENABLED, sideOf } from "../../lib/multi-outcome";
import { readableAmount } from "../../lib/market-display";
import {
  holdsContracts,
  loadMultiWallet,
  type MultiWalletMarket,
} from "../../lib/multi-outcome-wallet";

const STATUS = {
  open: "Open",
  filled: "Filled",
  canceled: "Canceled",
} as const;

export function MultiWalletActivity({
  mode,
}: {
  mode: "positions" | "orders";
}) {
  const { t } = useI18n();
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
    [filter, setFilter] = useState<"open" | "history" | "all">("open");
  // Live updates reload in the background; the list stays on screen.
  const quiet = useRef(-1);
  useIndexerUpdates(
    () => setRevision((v) => (quiet.current = v + 1)),
    [wallet?.publicKey.toBase58()],
  );
  useEffect(() => {
    let active = true;
    const background = revision === quiet.current;
    if (!background) {
      setResult(null);
      setError("");
    }
    if (!MULTI_OUTCOME_ENABLED || !wallet) return;
    if (!background) setLoading(true);
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
  const refresh = (
    <button
      className="text-button"
      type="button"
      disabled={loading}
      onClick={() => setRevision((v) => v + 1)}
    >
      {loading ? t("Refreshing…") : t("Refresh")}
    </button>
  );

  if (mode === "positions") {
    const held = rows.filter(holdsContracts);
    return (
      <section
        className="wallet-market-section"
        aria-labelledby="multi-positions-title"
      >
        <div className="wallet-section-heading">
          <div>
            <h2 id="multi-positions-title">{t("Multi-outcome positions")}</h2>
          </div>
          {refresh}
        </div>
        {error ? (
          <p className="wallet-empty" role="alert">
            {t("Multi-outcome positions could not be loaded.")}
          </p>
        ) : loading && !result ? (
          <p className="wallet-empty" role="status">
            {t("Loading multi-outcome positions…")}
          </p>
        ) : held.length === 0 ? (
          <p className="wallet-empty">{t("No multi-outcome positions yet.")}</p>
        ) : (
          <div className="wallet-market-grid">
            {held.map((r) => (
              <article
                className="admin-card wallet-market-card"
                key={r.key.toBase58()}
              >
                <span className="card-label">{t("Multi-outcome")}</span>
                <h3>{r.name}</h3>
                <dl className="wallet-market-numbers">
                  {r.market.terms.outcomeLabels.map((label, i) => (
                    <div key={i}>
                      <dt>{label}</dt>
                      <dd>
                        {r.position!.free[i].toString()}{" "}
                        <small>
                          {t("free · {value0} in orders", {
                            value0: r.position!.locked[i].toString(),
                          })}
                        </small>
                      </dd>
                    </div>
                  ))}
                </dl>
                <Link
                  className="market-open-link"
                  href={`/predictions/multi/${r.key.toBase58()}#multi-positions`}
                >
                  {t("Manage position →")}
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>
    );
  }

  const orders = rows
    .flatMap((r) => r.orders.map((o) => ({ market: r, order: o })))
    .filter(({ order }) => {
      const open = "open" in order.account.status;
      return filter === "all" || (filter === "open" ? open : !open);
    })
    .sort((a, b) => b.order.account.orderId.cmp(a.order.account.orderId));
  return (
    <section
      className="orders-ledger multi-orders-ledger"
      aria-labelledby="multi-orders-title"
    >
      <h2 id="multi-orders-title" className="orders-section-title">
        {t("Multi-outcome orders")}
      </h2>
      <div className="orders-toolbar">
        <div
          className="orders-filters"
          role="group"
          aria-label={t("Order status")}
        >
          {(["open", "history", "all"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t(
                { open: "Open", history: "History", all: "All orders" }[value],
              )}
            </button>
          ))}
        </div>
        {refresh}
      </div>
      {error ? (
        <p className="transaction-message transaction-error" role="alert">
          {t(error)}
        </p>
      ) : loading && !result ? (
        <p className="orders-empty" role="status">
          {t("Loading orders…")}
        </p>
      ) : orders.length === 0 ? (
        <p className="orders-empty">
          {filter === "open"
            ? t("No open orders.")
            : t("No orders found for this wallet.")}
        </p>
      ) : (
        <div className="orders-table-scroll">
          <table className="orders-table">
            <caption className="sr-only">{t("Multi-outcome orders")}</caption>
            <thead>
              <tr>
                {[
                  "Market",
                  "Side",
                  "Price",
                  "Remaining",
                  "Status",
                  "Action",
                ].map((label) => (
                  <th scope="col" key={label}>
                    {t(label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map(({ market: r, order: o }) => {
                const side = sideOf(o.account) === "bid" ? "Buy" : "Sell";
                const status = (Object.keys(o.account.status)[0] ??
                  "open") as keyof typeof STATUS;
                return (
                  <tr key={o.publicKey.toBase58()}>
                    <td>
                      <Link
                        className="orders-market-link"
                        href={`/predictions/multi/${r.key.toBase58()}`}
                      >
                        {r.name}
                      </Link>
                      <small>
                        {r.market.terms.outcomeLabels[o.account.outcome[0]]} · #
                        {o.account.orderId.toString()}
                      </small>
                    </td>
                    <td>
                      <span
                        className={
                          side === "Buy" ? "orders-buy" : "orders-sell"
                        }
                      >
                        {t(side)}
                      </span>
                    </td>
                    <td>{`${readableAmount(o.account.price, r.decimals)} ${r.symbol}`}</td>
                    <td>{o.account.remainingQuantity.toString()}</td>
                    <td>
                      <span className={`role-badge order-${status}`}>
                        {t(STATUS[status] ?? status)}
                      </span>
                    </td>
                    <td>
                      <Link
                        className="text-button"
                        href={`/predictions/multi/${r.key.toBase58()}#multi-trade`}
                      >
                        {t("Manage →")}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
