"use client";

import type { PublicKey } from "@solana/web3.js";
import type { SharedSnapshot } from "../lib/shared";
import { readableAmount } from "../lib/market-display";

interface Props {
  snapshot: SharedSnapshot | null;
  loaded: boolean;
  owner?: PublicKey;
  pending: boolean;
  decimals: number;
  quantityDecimals: number;
  symbol: string;
  onCancel: (order: PublicKey) => void;
}

/** Owner-only display; lifecycle never hides a cancellation path. */
export function SharedOpenOrders({
  snapshot,
  loaded,
  owner,
  pending,
  decimals,
  quantityDecimals,
  symbol,
  onCancel,
}: Props) {
  const orders =
    snapshot?.orders.filter(
      ({ account }) => owner?.equals(account.owner) && "open" in account.status,
    ) ?? [];
  return (
    <section
      className="shared-open-orders"
      aria-labelledby="shared-open-orders-heading"
    >
      <h2 id="shared-open-orders-heading">Your open orders</h2>
      {!owner ? (
        <p>Connect your wallet to see your orders.</p>
      ) : !loaded ? (
        <p>Loading orders…</p>
      ) : orders.length === 0 ? (
        <p className="prediction-empty-copy">No open orders in this market.</p>
      ) : (
        <div className="prediction-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Side</th>
                <th>Price ({symbol})</th>
                <th>Remaining</th>
                <th>
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map(({ publicKey, account }) => (
                <tr key={publicKey.toBase58()}>
                  <td>{Object.keys(account.outcome)[0].toUpperCase()}</td>
                  <td>{"bid" in account.side ? "Buy" : "Sell"}</td>
                  <td>{readableAmount(account.price, decimals)}</td>
                  <td>
                    {readableAmount(
                      account.remainingQuantity,
                      quantityDecimals,
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onCancel(publicKey)}
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
