"use client";
import { useI18n } from "./preferences-provider";

/** Owner history includes all shared books; cancellation refreshes its exact queue first. */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnchorProvider } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  SHARED_BALANCES_ENABLED,
  sharedAccounts,
  sharedOrderPda,
  readSharedBook,
  cancelShared,
  type SharedOrder,
  type SharedSnapshot,
} from "../lib/shared";
import {
  getTidebookReadProgram,
  getTidebookProgram,
  getTidebookAccounts,
  deriveMarketMetadataPda,
  type MarketMetadataAccount,
} from "../lib/tidebook";
import { readableAmount } from "../lib/market-display";
export function SharedOrders() {
  const wallet = useAnchorWallet(),
    { connection } = useConnection();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !wallet || !SHARED_BALANCES_ENABLED) return null;
  return <OwnerOrders key={`${connection.rpcEndpoint}:${wallet.publicKey}`} />;
}
function OwnerOrders() {
  const { t } = useI18n();

  const wallet = useAnchorWallet()!,
    { connection } = useConnection(),
    p = useMemo(() => getTidebookReadProgram(connection), [connection]);
  const [rows, setRows] = useState<
      Array<{
        address: PublicKey;
        order: SharedOrder;
        book: SharedSnapshot | null;
        metadata: MarketMetadataAccount | null;
      }>
    >([]),
    [pending, setPending] = useState(true),
    [issue, setIssue] = useState<string | null>(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState<"open" | "history" | "all">("open");
  useEffect(() => {
    let dead = false;
    setPending(true);
    setIssue(null);
    void (async () => {
      const owned = await sharedAccounts(p).sharedOrder.all([
        { memcmp: { offset: 8, bytes: wallet.publicKey.toBase58() } },
      ]);
      const markets = [
        ...new Map(
          owned.map((r) => [r.account.market.toBase58(), r.account.market]),
        ).values(),
      ];
      const contexts = new Map<
        string,
        { book: SharedSnapshot | null; metadata: MarketMetadataAccount | null }
      >();
      // Sequential per-market reads avoid a burst of account scans on free RPC plans.
      for (const market of markets) {
        const book = await readSharedBook(p, market);
        if (!book) {
          if (
            owned.some(
              (r) =>
                r.account.market.equals(market) && "open" in r.account.status,
            )
          )
            throw new Error("Open order is missing its shared book");
        }
        const metadata = await getTidebookAccounts(
          p,
        ).marketMetadata.fetchNullable(deriveMarketMetadataPda(market));
        contexts.set(market.toBase58(), { book, metadata });
      }
      const next = [];
      for (const r of owned) {
        if (
          !r.account.owner.equals(wallet.publicKey) ||
          !sharedOrderPda(r.account.book, r.account.orderId).equals(r.publicKey)
        )
          throw new Error("Shared order owner/address mismatch");
        const context = contexts.get(r.account.market.toBase58());
        if (context)
          next.push({ address: r.publicKey, order: r.account, ...context });
      }
      if (!dead)
        setRows(
          next.sort((left, right) =>
            right.order.orderId.cmp(left.order.orderId),
          ),
        );
    })()
      .catch((e) => {
        if (!dead) setIssue(String(e));
      })
      .finally(() => {
        if (!dead) setPending(false);
      });
    return () => {
      dead = true;
    };
  }, [p, wallet.publicKey, revision]);
  async function cancel(market: PublicKey, address: PublicKey) {
    setBusy(true);
    setIssue(null);
    try {
      const signed = getTidebookProgram(connection, wallet),
        current = await readSharedBook(signed, market);
      if (!current) throw new Error("Book unavailable");
      await (signed.provider as AnchorProvider).sendAndConfirm(
        new Transaction().add(
          await cancelShared(signed, current, wallet.publicKey, address),
        ),
      );
      setRevision((v) => v + 1);
    } catch (e) {
      setIssue(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const visible = rows.filter(
    (row) =>
      filter === "all" ||
      (filter === "open"
        ? "open" in row.order.status
        : !("open" in row.order.status)),
  );
  return (
    <section className="orders-ledger" aria-label={t("Your orders")}>
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
        <button
          className="text-button"
          type="button"
          disabled={busy || pending}
          onClick={() => setRevision((v) => v + 1)}
        >
          {pending ? t("Refreshing…") : t("Refresh")}
        </button>
      </div>
      {issue ? (
        <p className="transaction-message transaction-error" role="alert">
          {t(issue)}
        </p>
      ) : pending ? (
        <p className="orders-empty" role="status">
          {t("Loading orders…")}
        </p>
      ) : visible.length === 0 ? (
        <p className="orders-empty">
          {filter === "open"
            ? t("No open orders.")
            : t("No orders found for this wallet.")}
        </p>
      ) : (
        <div className="orders-table-scroll">
          <table className="orders-table">
            <caption className="sr-only">{t("Your orders")}</caption>
            <thead>
              <tr>
                {[
                  "Market",
                  "Side",
                  "Price",
                  "Quantity",
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
              {visible.map((r) => {
                const prediction = r.book
                  ? "prediction" in r.book.book.kind
                  : !("spot" in r.order.outcome);
                const units = r.book?.book;
                const side = "bid" in r.order.side ? "Buy" : "Sell";
                const status = Object.keys(r.order.status)[0];
                const quantityDecimals = prediction ? 0 : units?.baseDecimals;
                // A closed book cannot supply trustworthy spot decimals. Prediction
                // contracts are always whole units, even if their book was closed.
                const amount = (value: SharedOrder["quantity"]) =>
                  quantityDecimals === undefined
                    ? "—"
                    : readableAmount(value, quantityDecimals);
                return (
                  <tr key={r.address.toBase58()}>
                    <td>
                      <Link
                        className="orders-market-link"
                        href={`/${prediction ? "predictions" : "markets"}/${r.order.market}`}
                      >
                        {r.metadata?.displayName ??
                          `${r.order.market.toBase58().slice(0, 6)}…${r.order.market.toBase58().slice(-4)}`}
                      </Link>
                      <small>
                        {prediction
                          ? Object.keys(r.order.outcome)[0].toUpperCase()
                          : t("Spot")}{" "}
                        · #{r.order.orderId.toString()}
                        {!units && <> · {t("Closed market")}</>}
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
                    <td title={!units ? t("Units unavailable") : undefined}>
                      {units
                        ? `${readableAmount(r.order.price, units.quoteDecimals)} ${r.metadata?.quoteSymbol ?? t("quote")}`
                        : "—"}
                    </td>
                    <td
                      title={
                        quantityDecimals === undefined
                          ? t("Units unavailable")
                          : undefined
                      }
                    >
                      {amount(r.order.quantity)}
                    </td>
                    <td
                      title={
                        quantityDecimals === undefined
                          ? t("Units unavailable")
                          : undefined
                      }
                    >
                      {amount(r.order.remainingQuantity)}
                    </td>
                    <td>
                      <span className={`role-badge order-${status}`}>
                        {t(status)}
                      </span>
                    </td>
                    <td>
                      {"open" in r.order.status ? (
                        <button
                          className="text-button orders-cancel"
                          type="button"
                          disabled={busy}
                          onClick={() => void cancel(r.order.market, r.address)}
                        >
                          {busy ? t("Canceling…") : t("Cancel")}
                        </button>
                      ) : (
                        "—"
                      )}
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
