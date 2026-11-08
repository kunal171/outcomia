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
    [pending, setPending] = useState(false),
    [issue, setIssue] = useState<string | null>(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false);
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
      if (!dead) setRows(next);
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
  return (
    <section className="admin-card shared-market">
      <div className="section-heading">
        <h2>{t("Shared-wallet orders")}</h2>
        <button
          disabled={busy || pending}
          onClick={() => setRevision((v) => v + 1)}
        >
          {t("Refresh")}
        </button>
      </div>
      {issue ? (
        <p role="alert">{t(issue ?? "")}</p>
      ) : pending ? (
        <p>{t("Loading shared orders…")}</p>
      ) : rows.length === 0 ? (
        <p>{t("No shared orders yet.")}</p>
      ) : (
        rows.map((r) => {
          const prediction = r.book
            ? "prediction" in r.book.book.kind
            : !("spot" in r.order.outcome);
          const units = r.book?.book;
          return (
            <article className="admin-card" key={r.address.toBase58()}>
              <Link
                href={`/${prediction ? "predictions" : "markets"}/${r.order.market}`}
              >
                {r.metadata?.displayName ??
                  `${r.order.market.toBase58().slice(0, 8)}…`}
              </Link>
              <p>
                {`${Object.keys(r.order.outcome)[0].toUpperCase()} · ${"bid" in r.order.side ? t("Buy") : t("Sell")} · ${Object.keys(r.order.status)[0]}`}
              </p>
              <p>
                {t(
                  "Price: {value0} {value1} · Quantity: {value2} · Remaining: {value3}",
                  {
                    value0: units
                      ? readableAmount(r.order.price, units.quoteDecimals)
                      : "—",
                    value1: r.metadata?.quoteSymbol ?? t("quote"),
                    value2: units
                      ? readableAmount(r.order.quantity, units.baseDecimals)
                      : "—",
                    value3: units
                      ? readableAmount(
                          r.order.remainingQuantity,
                          units.baseDecimals,
                        )
                      : "—",
                  },
                )}
              </p>
              {!units && (
                <p>
                  {t(
                    "Closed book. Token precision is unavailable; order #{value0} remains on chain.",
                    { value0: r.order.orderId.toString() },
                  )}
                </p>
              )}
              {"open" in r.order.status && (
                <button
                  disabled={busy}
                  onClick={() => void cancel(r.order.market, r.address)}
                >
                  {t("Cancel")}
                </button>
              )}
            </article>
          );
        })
      )}
      <p>
        {t(
          "Cancellation works after pause, cutoff or resolution. Legacy orders are listed separately below.",
        )}
      </p>
    </section>
  );
}
