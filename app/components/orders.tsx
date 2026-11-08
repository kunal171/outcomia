"use client";
import { useI18n } from "./preferences-provider";

import { SharedOrders } from "./shared-orders";
import { SHARED_BALANCES_ENABLED } from "../lib/shared";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";

import {
  decodeOrderSide,
  decodeOrderStatus,
  derivePriceLevelPda,
  deriveTraderBalancePda,
  deriveMarketMetadataPda,
  getTidebookAccounts,
  getTidebookProgram,
  transactionExplorerUrl,
  type OrderView,
  type MarketAccount,
  type MarketMetadataAccount,
} from "../lib/tidebook";
import { AppHeader } from "./app-header";
import { marketLabels, readableAmount } from "../lib/market-display";
import { rpcErrorMessage } from "../lib/rpc-transport";

function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function getErrorMessage(cause: unknown) {
  return rpcErrorMessage(cause, "Transaction failed");
}

/** The page owns navigation; each ledger keeps its existing cancellation path. */
export function Orders() {
  const { t } = useI18n();
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const [legacyOpen, setLegacyOpen] = useState(false);
  const identity = `${connection.rpcEndpoint}:${wallet?.publicKey.toBase58() ?? ""}`;
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell orders-workspace">
        <div className="route-heading">
          <h1>{t("Orders")}</h1>
        </div>
        {!wallet ? (
          <div className="access-card">
            {t("Connect your wallet to view your orders.")}
          </div>
        ) : SHARED_BALANCES_ENABLED ? (
          <>
            <SharedOrders />
            <details
              className="orders-legacy"
              onToggle={(event) => setLegacyOpen(event.currentTarget.open)}
            >
              <summary>{t("Legacy orders")}</summary>
              {legacyOpen && <LegacyOrders key={identity} />}
            </details>
          </>
        ) : (
          <LegacyOrders key={identity} />
        )}
      </main>
    </div>
  );
}

function LegacyOrders() {
  const { t } = useI18n();

  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const [orders, setOrders] = useState<OrderView[]>([]);
  const [orderMarkets, setOrderMarkets] = useState<
    Map<
      string,
      { market: MarketAccount; metadata: MarketMetadataAccount | null }
    >
  >(() => new Map());
  const [loading, setLoading] = useState(true);
  const [pendingOrder, setPendingOrder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  const program = useMemo(
    () => (wallet ? getTidebookProgram(connection, wallet) : null),
    [connection, wallet],
  );

  const loadOrders = useCallback(async () => {
    if (!program || !wallet) {
      setOrders([]);
      setOrderMarkets(new Map());
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const records = await getTidebookAccounts(program).order.all([
        {
          memcmp: {
            offset: 8,
            bytes: wallet.publicKey.toBase58(),
          },
        },
      ]);

      setOrders(
        records
          .map(({ publicKey, account }) => ({
            address: publicKey,
            ...account,
          }))
          .sort((left, right) => right.orderId.cmp(left.orderId)),
      );
      // Batch only the markets referenced by this wallet's orders (50 pairs
      // per request), rather than fetching each market and mint separately.
      const keys = [
        ...new Map(
          records.map(({ account }) => [
            account.market.toBase58(),
            account.market,
          ]),
        ).values(),
      ];
      const views = new Map<
        string,
        { market: MarketAccount; metadata: MarketMetadataAccount | null }
      >();
      for (let start = 0; start < keys.length; start += 50) {
        const batch = keys.slice(start, start + 50);
        const infos = await connection.getMultipleAccountsInfo(
          [...batch, ...batch.map(deriveMarketMetadataPda)],
          "confirmed",
        );
        batch.forEach((key, index) => {
          const info = infos[index];
          if (!info || !info.owner.equals(program.programId)) return;
          try {
            const market = program.coder.accounts.decode<MarketAccount>(
              "market",
              info.data,
            );
            const metadataInfo = infos[index + batch.length];
            let metadata: MarketMetadataAccount | null = null;
            if (metadataInfo?.owner.equals(program.programId)) {
              try {
                const value =
                  program.coder.accounts.decode<MarketMetadataAccount>(
                    "marketMetadata",
                    metadataInfo.data,
                  );
                if (value.market.equals(key)) metadata = value;
              } catch {
                /* Missing/old labels never turn an order into fake units. */
              }
            }
            views.set(key.toBase58(), { market, metadata });
          } catch {
            /* Closed or incompatible markets have unavailable units. */
          }
        });
      }
      setOrderMarkets(views);
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [program, wallet, connection]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  const cancelOrder = async (order: OrderView) => {
    if (!program || !wallet) return;

    const address = order.address.toBase58();

    setPendingOrder(address);
    setError(null);
    setSignature(null);

    try {
      const accounts = getTidebookAccounts(program);
      const priceLevel = await accounts.priceLevel.fetchNullable(
        order.priceLevel,
      );
      if (!priceLevel) {
        throw new Error("The order's price-level account was not found");
      }

      const side = decodeOrderSide(order.side);
      const removesPriceLevel = priceLevel.orderCount.eqn(1);
      const betterLevel =
        removesPriceLevel && priceLevel.betterPrice
          ? derivePriceLevelPda(order.market, side, priceLevel.betterPrice)
          : null;
      const worseLevel =
        removesPriceLevel && priceLevel.worsePrice
          ? derivePriceLevelPda(order.market, side, priceLevel.worsePrice)
          : null;
      const levelRentRecipient = removesPriceLevel
        ? priceLevel.rentPayer
        : null;
      const traderBalance = deriveTraderBalancePda(
        order.market,
        wallet.publicKey,
      );

      const transaction = await program.methods
        .cancelLimitOrder(order.orderId)
        .accountsPartial({
          owner: wallet.publicKey,
          market: order.market,
          order: order.address,
          priceLevel: order.priceLevel,
          previousOrder: order.previousOrder ?? program.programId,
          nextOrder: order.nextOrder ?? program.programId,
          betterLevel: betterLevel ?? program.programId,
          worseLevel: worseLevel ?? program.programId,
          levelRentRecipient: levelRentRecipient ?? program.programId,
          traderBalance,
        })
        .rpc();

      setSignature(transaction);
      await loadOrders();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setPendingOrder(null);
    }
  };

  return (
    <div className="orders-legacy-content">
      {wallet && (
        <section aria-label={t("Legacy orders")}>
          <div className="admin-list-heading">
            <h2>{t("Legacy orders")}</h2>

            <button
              className="text-button"
              type="button"
              disabled={loading}
              onClick={() => void loadOrders()}
            >
              {loading ? t("Refreshing…") : t("Refresh")}
            </button>
          </div>

          {loading && <p role="status">{t("Loading orders…")}</p>}
          {!loading && !error && orders.length === 0 && (
            <p>{t("No orders found for this wallet.")}</p>
          )}

          <div className="orders-list">
            {orders.map((order) => {
              const status = decodeOrderStatus(order.status);
              const side = decodeOrderSide(order.side);
              const address = order.address.toBase58();
              const view = orderMarkets.get(order.market.toBase58());
              const labels = view
                ? marketLabels(view.market, view.metadata)
                : null;

              return (
                <article className="order-row" key={address}>
                  <div className="order-details">
                    <div>
                      <span>{t("Order")}</span>
                      <strong>
                        {"#"}
                        {order.orderId.toString()}
                      </strong>
                    </div>

                    <div>
                      <span>{t("Market")}</span>
                      <strong>
                        <Link href={`/markets/${order.market.toBase58()}`}>
                          {labels?.name ??
                            shortAddress(order.market.toBase58())}
                        </Link>
                      </strong>
                    </div>

                    <div>
                      <span>{t("Side")}</span>
                      <strong>{side === "bid" ? t("Buy") : t("Sell")}</strong>
                    </div>

                    <div>
                      <span>{t("Price")}</span>
                      <strong>
                        {view
                          ? `${readableAmount(order.price, view.market.quoteDecimals)} ${labels?.quote}`
                          : t("Units unavailable")}
                      </strong>
                    </div>

                    <div>
                      <span>{t("Quantity")}</span>
                      <strong>
                        {view
                          ? `${readableAmount(order.quantity, view.market.baseDecimals)} ${labels?.base}`
                          : t("Units unavailable")}
                      </strong>
                    </div>

                    <div>
                      <span>{t("Remaining")}</span>
                      <strong>
                        {view
                          ? `${readableAmount(order.remainingQuantity, view.market.baseDecimals)} ${labels?.base}`
                          : t("Units unavailable")}
                      </strong>
                    </div>

                    <div>
                      <span>{t("Filled")}</span>
                      <strong>
                        {view
                          ? `${readableAmount(order.quantity.sub(order.remainingQuantity), view.market.baseDecimals)} ${labels?.base}`
                          : t("Units unavailable")}
                      </strong>
                    </div>

                    <div>
                      <span>{t("Locked collateral")}</span>
                      <strong>
                        {view
                          ? `${readableAmount(order.lockedCollateral, side === "bid" ? view.market.quoteDecimals : view.market.baseDecimals)} ${side === "bid" ? labels?.quote : labels?.base}`
                          : t("Units unavailable")}
                      </strong>
                    </div>
                  </div>

                  <div className="order-actions">
                    <span className={`role-badge order-${status}`}>
                      {t(status ?? "")}
                    </span>

                    {status === "open" && (
                      <button
                        className="danger-button"
                        type="button"
                        disabled={pendingOrder !== null}
                        onClick={() => void cancelOrder(order)}
                      >
                        {pendingOrder === address
                          ? t("Canceling…")
                          : t("Cancel")}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {error && (
        <div className="transaction-message transaction-error">
          {t(error ?? "")}
        </div>
      )}

      {signature && (
        <div className="transaction-message transaction-success">
          {t("Order canceled and collateral released to your free balance.")}{" "}
          <a
            href={transactionExplorerUrl(signature)}
            target="_blank"
            rel="noreferrer"
          >
            {t("View transaction ↗")}
          </a>
        </div>
      )}
    </div>
  );
}
