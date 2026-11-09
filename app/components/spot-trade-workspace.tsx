"use client";

import { useId } from "react";
import { BN } from "@anchor-lang/core";
import type { SharedSnapshot, Side } from "../lib/shared";
import { readableAmount } from "../lib/market-display";
import { useI18n } from "./preferences-provider";

interface Props {
  snapshot: SharedSnapshot;
  loaded: boolean;
  failed: boolean;
  pending: boolean;
  connected: boolean;
  canTrade: boolean;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  side: Side;
  price: string;
  quantity: string;
  onSide: (value: Side) => void;
  onPrice: (value: string) => void;
  onQuantity: (value: string) => void;
  onTrade: () => void;
}

/** Presentation only. The parent owns the snapshot, exact input parsing and signing.
 * Same-price open orders are summed with BN; no quote or balance is synthesized.
 */
export function SpotTradeWorkspace(props: Props) {
  const { t } = useI18n();
  const hintId = useId();
  const blocked =
    props.pending ||
    !props.loaded ||
    !props.canTrade ||
    !props.price ||
    !props.quantity;
  return (
    <div className="spot-trading-layout">
      <section className="spot-book" aria-label={t("Order book")}>
        <h3>{t("Order book")}</h3>
        {!props.loaded ? (
          <p role="status">
            {props.failed
              ? t("Order book unavailable")
              : t("Loading order book…")}
          </p>
        ) : (
          <div className="spot-book-sides">
            {(["bid", "ask"] as const).map((side) => {
              const levels = new Map<string, { price: BN; quantity: BN }>();
              for (const { account } of props.snapshot.orders) {
                if (
                  !("open" in account.status) ||
                  !("spot" in account.outcome) ||
                  !(side in account.side)
                )
                  continue;
                const key = account.price.toString();
                levels.set(key, {
                  price: account.price,
                  quantity: (levels.get(key)?.quantity ?? new BN(0)).add(
                    account.remainingQuantity,
                  ),
                });
              }
              const rows = [...levels.values()].sort((a, b) =>
                side === "bid" ? b.price.cmp(a.price) : a.price.cmp(b.price),
              );
              return (
                <div className={`spot-book-side book-${side}`} key={side}>
                  <h4>{side === "bid" ? t("Buy orders") : t("Sell orders")}</h4>
                  <div className="spot-ladder-scroll">
                    <table>
                      <caption className="sr-only">
                        {side === "bid" ? t("Buy orders") : t("Sell orders")}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">
                            {t("Price ({value0})", {
                              value0: props.quoteSymbol,
                            })}
                          </th>
                          <th scope="col">
                            {t("Quantity ({value0})", {
                              value0: props.baseSymbol,
                            })}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.price.toString()}>
                            <td>
                              <button
                                type="button"
                                disabled={props.pending}
                                aria-label={t(
                                  "Use limit price {value0} {value1}",
                                  {
                                    value0: readableAmount(
                                      row.price,
                                      props.quoteDecimals,
                                    ),
                                    value1: props.quoteSymbol,
                                  },
                                )}
                                onClick={() =>
                                  props.onPrice(
                                    readableAmount(
                                      row.price,
                                      props.quoteDecimals,
                                    ),
                                  )
                                }
                              >
                                {readableAmount(row.price, props.quoteDecimals)}
                              </button>
                            </td>
                            <td>
                              {readableAmount(row.quantity, props.baseDecimals)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!rows.length && (
                    <p className="spot-empty">
                      {side === "bid"
                        ? t("No buy orders")
                        : t("No sell orders")}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
      <section className="spot-ticket" aria-label={t("Place an order")}>
        <h3>{t("Place an order")}</h3>
        {!props.connected ? (
          <p>{t("Connect a wallet to trade.")}</p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!blocked) props.onTrade();
            }}
          >
            <label>
              {t("Buy or sell")}
              <select
                value={props.side}
                disabled={props.pending}
                onChange={(event) => props.onSide(event.target.value as Side)}
              >
                <option value="bid">
                  {t("Buy {value0}", { value0: props.baseSymbol })}
                </option>
                <option value="ask">
                  {t("Sell {value0}", { value0: props.baseSymbol })}
                </option>
              </select>
            </label>
            <div className="spot-field">
              <label>
                {t("Price ({value0} per {value1})", {
                  value0: props.quoteSymbol,
                  value1: props.baseSymbol,
                })}
                <input
                  aria-describedby={`${hintId}-price`}
                  inputMode="decimal"
                  value={props.price}
                  disabled={props.pending}
                  onChange={(event) => props.onPrice(event.target.value)}
                />
              </label>
              <small id={`${hintId}-price`}>
                {t("Minimum price increment: {value0} {value1}", {
                  value0: readableAmount(
                    props.snapshot.book.priceTick,
                    props.quoteDecimals,
                  ),
                  value1: props.quoteSymbol,
                })}
              </small>
            </div>
            <div className="spot-field">
              <label>
                {t("Quantity ({value0})", { value0: props.baseSymbol })}
                <input
                  aria-describedby={`${hintId}-quantity`}
                  inputMode="decimal"
                  value={props.quantity}
                  disabled={props.pending}
                  onChange={(event) => props.onQuantity(event.target.value)}
                />
              </label>
              <small id={`${hintId}-quantity`}>
                {t("Minimum quantity increment: {value0} {value1}", {
                  value0: readableAmount(
                    props.snapshot.book.quantityLot,
                    props.baseDecimals,
                  ),
                  value1: props.baseSymbol,
                })}
              </small>
            </div>
            <button
              className="spot-submit"
              data-side={props.side}
              type="submit"
              disabled={blocked}
            >
              {props.pending
                ? t("Confirm in wallet…")
                : props.side === "bid"
                  ? t("Buy {value0}", { value0: props.baseSymbol })
                  : t("Sell {value0}", { value0: props.baseSymbol })}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
