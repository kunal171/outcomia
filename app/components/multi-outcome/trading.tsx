"use client";
import { useState } from "react";
import Link from "next/link";
import { Transaction, SystemProgram } from "@solana/web3.js";
import { parseTokenAmount, TOKEN_PROGRAM_ID } from "../../lib/outcomia";
import { readableAmount } from "../../lib/market-display";
import { PROGRAM_ID } from "../../lib/solana";
import {
  COMPLEMENTARY_MATCHING_ENABLED,
  assetBalancePda,
  assetCustody,
} from "../../lib/shared";
import {
  buildMultiTrade,
  fullSetQuote,
  multiBookPda,
  multiPositionPda,
  sideOf,
  whole,
  type Side,
} from "../../lib/multi-outcome";
import { useMarketClock } from "./use-clock";
import type { MultiSession } from "./use-market";
export function MultiTrading({ session: s }: { session: MultiSession }) {
  const [outcome, setOutcome] = useState(0),
    [side, setSide] = useState<Side>("bid"),
    [price, setPrice] = useState(""),
    [quantity, setQuantity] = useState(""),
    [left, setLeft] = useState("");
  const now = useMarketClock();
  const d = s.data;
  if (!d) return null;
  const ready = !!s.signed && !!s.wallet && !s.busy && !s.loading;
  const trading =
    "open" in d.market.status && now < d.market.terms.closeTs.toNumber();
  const rows =
    d.book?.rows.filter((r) => r.account.outcome[0] === outcome) ?? [];
  const sorted = [...rows].sort(
    (a, b) =>
      sideOf(a.account).localeCompare(sideOf(b.account)) ||
      a.account.price.cmp(b.account.price) ||
      a.account.orderId.cmp(b.account.orderId),
  );
  // Liquidity reachable through every other outcome's best order (full set).
  const fullSetText =
    COMPLEMENTARY_MATCHING_ENABLED && d.book
      ? (["bid", "ask"] as const)
          .map((q) => {
            const quote = fullSetQuote(
              d.market,
              d.book!.book,
              outcome,
              q,
              d.book!.rows,
            );
            return quote
              ? `${q === "bid" ? "Buy" : "Sell"} via other outcomes: ${readableAmount(quote.price, d.decimals)} × ${quote.quantity.toString()}`
              : null;
          })
          .filter(Boolean)
          .join(" · ")
      : "";
  return (
    <section aria-labelledby="multi-trade">
      <h2 id="multi-trade">Trade</h2>
      <label>
        Outcome
        <select
          disabled={s.busy}
          value={outcome}
          onChange={(e) => setOutcome(Number(e.target.value))}
        >
          {d.market.terms.outcomeLabels.map((label, i) => (
            <option key={i} value={i}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="multi-grid">
        <div className="multi-card">
          <h3>Order book</h3>
          <div className="multi-scroll">
            <table>
              <thead>
                <tr>
                  <th>Side</th>
                  <th>Price</th>
                  <th>Contracts</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.publicKey.toBase58()}>
                    <td>{sideOf(r.account) === "bid" ? "Buy" : "Sell"}</td>
                    <td>{readableAmount(r.account.price, d.decimals)}</td>
                    <td>{r.account.remainingQuantity.toString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <p>No resting orders for this outcome.</p>}
          {fullSetText && <p className="multi-full-set">{fullSetText}</p>}
        </div>
        <div className="multi-card">
          <h3>Limit order</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void (async () => {
                let unsubmitted: string | null = null;
                const confirmed = await s.send(async () => {
                  if (!s.signed || !s.wallet || !d.book)
                    throw new Error("Initialize the market book first.");
                  const plan = await buildMultiTrade(
                    s.signed,
                    d.key,
                    d.market,
                    d.book.book,
                    d.book.rows,
                    s.wallet.publicKey,
                    outcome,
                    side,
                    parseTokenAmount(price, d.decimals, "Price"),
                    whole(quantity),
                    d.feeBps,
                  );
                  unsubmitted = plan.remaining.isZero()
                    ? ""
                    : plan.remaining.toString();
                  return plan.transaction;
                });
                if (confirmed && unsubmitted !== null) {
                  setQuantity(unsubmitted);
                  setLeft(
                    unsubmitted
                      ? `${unsubmitted} contracts remain unsubmitted. Refresh and explicitly retry.`
                      : "",
                  );
                }
              })();
            }}
          >
            <label>
              Side
              <select
                disabled={s.busy}
                value={side}
                onChange={(e) => setSide(e.target.value as Side)}
              >
                <option value="bid">Buy</option>
                <option value="ask">Sell</option>
              </select>
            </label>
            <label>
              Limit price ({d.metadata?.quoteSymbol ?? "collateral"})
              <input
                required
                inputMode="decimal"
                disabled={s.busy}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
            <label>
              Contracts (multiples of {d.market.terms.quantityLot.toString()})
              <input
                required
                inputMode="numeric"
                disabled={s.busy}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>
            <p>
              Taker fee: {d.feeBps / 100}%. Maker orders pay no fee. Fills
              execute at maker prices; any safe remainder rests at your limit.
            </p>
            <button
              disabled={!ready || !trading || !d.book || !d.position || !d.cash}
            >
              Review in wallet
            </button>
            {left && s.signature && <p role="status">{left}</p>}
          </form>
        </div>
      </div>
      <p>
        Available collateral:{" "}
        {d.cash
          ? readableAmount(d.cash.free, d.decimals)
          : "Account not initialized"}
        . <Link href="/wallet">Deposit or withdraw in Wallet →</Link>
      </p>
      {(!d.position || !d.cash) && (
        <button
          disabled={!ready}
          onClick={() =>
            void s.send(async () => {
              if (!s.signed || !s.wallet) throw new Error("Connect a wallet.");
              const owner = s.wallet.publicKey,
                tx = new Transaction();
              if (!d.cash)
                tx.add(
                  await s.signed.methods
                    .initializeAssetBalance()
                    .accountsStrict({
                      ...assetCustody(owner, d.market.collateralMint),
                      tokenProgram: TOKEN_PROGRAM_ID,
                      systemProgram: SystemProgram.programId,
                    })
                    .instruction(),
                );
              if (!d.position)
                tx.add(
                  await s.signed.methods
                    .initializeMultiOutcomePosition()
                    .accountsStrict({
                      owner,
                      market: d.key,
                      position: multiPositionPda(d.key, owner),
                      systemProgram: SystemProgram.programId,
                    })
                    .instruction(),
                );
              return tx;
            })
          }
        >
          Initialize trading accounts
        </button>
      )}
      <h3>Your open orders</h3>
      {rows
        .filter((r) =>
          r.account.owner.equals(s.wallet?.publicKey ?? PROGRAM_ID),
        )
        .map((r) => (
          <p key={r.publicKey.toBase58()}>
            {sideOf(r.account) === "bid" ? "Buy" : "Sell"}{" "}
            {r.account.remainingQuantity.toString()} at{" "}
            {readableAmount(r.account.price, d.decimals)}{" "}
            <button
              disabled={!ready}
              onClick={() =>
                void s.send(async () => {
                  if (!s.signed || !s.wallet)
                    throw new Error("Connect a wallet.");
                  return new Transaction().add(
                    await s.signed.methods
                      .cancelMultiOutcomeOrder()
                      .accountsStrict({
                        owner: s.wallet.publicKey,
                        market: d.key,
                        book: multiBookPda(d.key),
                        order: r.publicKey,
                        cash: assetBalancePda(
                          s.wallet.publicKey,
                          d.market.collateralMint,
                        ),
                        position: multiPositionPda(d.key, s.wallet.publicKey),
                        previous: r.account.previous ?? PROGRAM_ID,
                        next: r.account.next ?? PROGRAM_ID,
                      })
                      .instruction(),
                  );
                })
              }
            >
              Cancel
            </button>
          </p>
        ))}
    </section>
  );
}
