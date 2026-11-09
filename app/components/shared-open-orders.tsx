"use client";
import { useI18n } from "./preferences-provider";

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
  assetSymbol?: string;
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
  assetSymbol,
  onCancel,
}: Props) {
  const { t } = useI18n();

  const spot = !!snapshot && "spot" in snapshot.book.kind;
  const orders =
    snapshot?.orders.filter(
      ({ account }) => owner?.equals(account.owner) && "open" in account.status,
    ) ?? [];
  return (
    <section
      className="shared-open-orders"
      aria-labelledby="shared-open-orders-heading"
    >
      <h2 id="shared-open-orders-heading">{t("Your open orders")}</h2>
      {!owner ? (
        <p>{t("Connect your wallet to see your orders.")}</p>
      ) : !loaded ? (
        <p>{t("Loading orders…")}</p>
      ) : orders.length === 0 ? (
        <p className="prediction-empty-copy">
          {t("No open orders in this market.")}
        </p>
      ) : (
        <div className="prediction-table-scroll">
          <table>
            <thead>
              <tr>
                <th>{spot ? t("Asset") : t("Contract")}</th>
                <th>{t("Side")}</th>
                <th>{t("Price ({value0})", { value0: symbol })}</th>
                <th>{t("Remaining")}</th>
                <th>
                  <span className="sr-only">{t("Action")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map(({ publicKey, account }) => (
                <tr key={publicKey.toBase58()}>
                  <td>
                    {spot
                      ? (assetSymbol ?? t("Spot"))
                      : t(Object.keys(account.outcome)[0].toUpperCase() ?? "")}
                  </td>
                  <td>{"bid" in account.side ? t("Buy") : t("Sell")}</td>
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
                      {t("Cancel")}
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
