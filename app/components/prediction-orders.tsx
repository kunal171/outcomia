"use client";

import { useCallback, useEffect, useState } from "react";
import { AnchorProvider, type Program } from "@anchor-lang/core";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  PREDICTION_CANCELLATION_ENABLED,
  readPredictionCancellationAccounts,
  type PredictionOrderAccount,
} from "../lib/prediction";
import {
  accountExplorerUrl,
  formatAtomicAmount,
  getTidebookAccounts,
} from "../lib/tidebook";

interface Props {
  program: Program;
  owner: PublicKey;
  market: PublicKey;
  decimals: number;
  symbol: string;
  pending: boolean;
  setPending: (pending: boolean) => void;
  onCanceled: (signature: string) => void;
}

/** Wallet-scoped list lives inside the keyed position panel. Reads are public;
 * only the connected order owner can sign cancellation, including after close. */
export function PredictionOrders({
  program,
  owner,
  market,
  decimals,
  symbol,
  pending,
  setPending,
  onCanceled,
}: Props) {
  const [orders, setOrders] = useState<
    Array<{ publicKey: PublicKey; account: PredictionOrderAccount }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    // Borsh stores the discriminator (8 bytes), owner (32), then market (32).
    // Filter on both fixed fields so RPC returns only this wallet/market pair.
    getTidebookAccounts(program)
      .predictionOrder.all([
        { memcmp: { offset: 8, bytes: owner.toBase58() } },
        { memcmp: { offset: 40, bytes: market.toBase58() } },
      ])
      .then((records) => {
        if (
          records.some(
            ({ account }) =>
              !account.owner.equals(owner) || !account.market.equals(market),
          )
        )
          throw new Error("Order list ownership mismatch");
        if (!canceled)
          setOrders(
            records.sort((a, b) => b.account.orderId.cmp(a.account.orderId)),
          );
      })
      .catch((cause) => {
        if (!canceled)
          setError(
            cause instanceof Error ? cause.message : "Unable to read orders",
          );
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [program, owner, market, refresh]);
  const cancel = useCallback(
    async (address: PublicKey) => {
      if (pending || !PREDICTION_CANCELLATION_ENABLED) return;
      setPending(true);
      setError(null);
      try {
        const reader = getTidebookAccounts(program);
        const accounts = await readPredictionCancellationAccounts(
          reader,
          market,
          owner,
          address,
        );
        const order = await reader.predictionOrder.fetchNullable(address);
        if (!order) throw new Error("Order disappeared; refresh");
        const ix = await program.methods
          .cancelPredictionOrder(order.orderId)
          .accountsStrict(accounts)
          .instruction();
        const signature = await (
          program.provider as AnchorProvider
        ).sendAndConfirm(new Transaction().add(ix));
        onCanceled(signature);
        setRefresh((value) => value + 1);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Cancellation failed",
        );
      } finally {
        setPending(false);
      }
    },
    [program, market, owner, pending, setPending, onCanceled],
  );
  return (
    <section className="prediction-orders">
      <div className="market-list-heading">
        <h3>Your prediction orders</h3>
        <button
          className="text-button"
          type="button"
          disabled={pending || loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh orders
        </button>
      </div>
      <p>
        Cancel an open order to release its remaining funds. Cancellation stays
        available after trading closes; withdrawing moves free collateral back
        to your wallet.
      </p>
      {!PREDICTION_CANCELLATION_ENABLED && (
        <p>Cancellation is awaiting deployment of this program version.</p>
      )}
      {loading && <p role="status">Loading orders…</p>}
      {error && (
        <p className="access-denied" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && orders.length === 0 && (
        <p>No orders for this wallet in this market.</p>
      )}
      {!loading &&
        !error &&
        orders.map(({ publicKey, account }) => (
          <article className="admin-card" key={publicKey.toBase58()}>
            <h4>
              #{account.orderId.toString()} ·{" "}
              {"yes" in account.outcome ? "YES" : "NO"} ·{" "}
              {"bid" in account.side ? "Buy" : "Sell"}
            </h4>
            <dl className="market-metadata">
              <div>
                <dt>Price</dt>
                <dd>
                  {formatAtomicAmount(account.price, decimals)} {symbol}
                </dd>
              </div>
              <div>
                <dt>Contracts</dt>
                <dd>{account.quantity.toString()}</dd>
              </div>
              <div>
                <dt>Remaining</dt>
                <dd>{account.remainingQuantity.toString()}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  {"open" in account.status
                    ? "Open"
                    : "canceled" in account.status
                      ? "Canceled"
                      : "Filled"}
                </dd>
              </div>
            </dl>
            <a
              className="market-explorer-link"
              href={accountExplorerUrl(publicKey)}
              target="_blank"
              rel="noreferrer"
            >
              View order ↗
            </a>
            {"open" in account.status && (
              <button
                className="secondary-button"
                type="button"
                disabled={pending || !PREDICTION_CANCELLATION_ENABLED}
                onClick={() => void cancel(publicKey)}
              >
                {pending ? "Confirming…" : "Cancel order"}
              </button>
            )}
          </article>
        ))}
    </section>
  );
}
