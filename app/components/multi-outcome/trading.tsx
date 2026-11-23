"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  createMarketTableInstructions,
  findMarketTable,
} from "../../lib/market-lookup-table";
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
import { useI18n } from "../preferences-provider";
export function MultiTrading({ session: s }: { session: MultiSession }) {
  const [outcome, setOutcome] = useState(0),
    [side, setSide] = useState<Side>("bid"),
    [price, setPrice] = useState(""),
    [quantity, setQuantity] = useState(""),
    [left, setLeft] = useState("");
  const now = useMarketClock(),
    { t } = useI18n();
  // Large full sets need the market's frozen lookup table (see
  // lib/market-lookup-table.ts). Only markets with six or more outcomes look.
  const [table, setTable] = useState<AddressLookupTableAccount | null>(null),
    [tableState, setTableState] = useState<
      "unneeded" | "checking" | "missing" | "ready"
    >("unneeded"),
    [tableRevision, setTableRevision] = useState(0);
  const marketKey = s.data?.key.toBase58(),
    mintKey = s.data?.market.collateralMint.toBase58(),
    outcomeCount = s.data?.market.terms.outcomeLabels.length ?? 0,
    connection = s.reader.provider.connection;
  useEffect(() => {
    if (
      !COMPLEMENTARY_MATCHING_ENABLED ||
      !marketKey ||
      !mintKey ||
      outcomeCount < 6
    ) {
      setTable(null);
      setTableState("unneeded");
      return;
    }
    let active = true;
    setTableState("checking");
    findMarketTable(
      connection,
      new PublicKey(marketKey),
      new PublicKey(mintKey),
    )
      .then((found) => {
        if (!active) return;
        setTable(found);
        setTableState(found ? "ready" : "missing");
      })
      .catch(() => {
        if (!active) return;
        setTable(null);
        setTableState("missing");
      });
    return () => {
      active = false;
    };
  }, [connection, marketKey, mintKey, outcomeCount, tableRevision]);
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
              ? t(
                  q === "bid"
                    ? "Buy via other outcomes: {price} × {quantity}"
                    : "Sell via other outcomes: {price} × {quantity}",
                  {
                    price: readableAmount(quote.price, d.decimals),
                    quantity: quote.quantity.toString(),
                  },
                )
              : null;
          })
          .filter(Boolean)
          .join(" · ")
      : "";
  return (
    <section aria-labelledby="multi-trade">
      <h2 id="multi-trade">{t("Trade")}</h2>
      <label>
        {t("Outcome")}
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
          <h3>{t("Order book")}</h3>
          <div className="multi-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Side")}</th>
                  <th>{t("Price")}</th>
                  <th>{t("Contracts")}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.publicKey.toBase58()}>
                    <td>{t(sideOf(r.account) === "bid" ? "Buy" : "Sell")}</td>
                    <td>{readableAmount(r.account.price, d.decimals)}</td>
                    <td>{r.account.remainingQuantity.toString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && (
            <p>{t("No resting orders for this outcome.")}</p>
          )}
          {fullSetText && <p className="multi-full-set">{fullSetText}</p>}
          {tableState === "missing" && (
            <p className="multi-full-set">
              {t(
                "Full sets across this many outcomes need a one-time lookup table for this market (about 0.003 SOL rent, never refunded).",
              )}{" "}
              <button
                type="button"
                disabled={s.busy || !s.wallet}
                onClick={() =>
                  void s
                    .send(async () => {
                      if (!s.wallet) throw new Error("Connect a wallet.");
                      const slot = await connection.getSlot("finalized");
                      const { instructions } = createMarketTableInstructions(
                        s.wallet.publicKey,
                        d.key,
                        d.market.collateralMint,
                        slot,
                      );
                      return new Transaction().add(...instructions);
                    })
                    .then((ok) => ok && setTableRevision((v) => v + 1))
                }
              >
                {t("Enable large full-set fills")}
              </button>
            </p>
          )}
        </div>
        <div className="multi-card">
          <h3>{t("Limit order")}</h3>
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
                    COMPLEMENTARY_MATCHING_ENABLED,
                    [],
                    table,
                  );
                  unsubmitted = plan.remaining.isZero()
                    ? ""
                    : plan.remaining.toString();
                  if (!plan.lookupTable) return plan.transaction;
                  const { blockhash } =
                    await connection.getLatestBlockhash("confirmed");
                  return new VersionedTransaction(
                    new TransactionMessage({
                      payerKey: s.wallet.publicKey,
                      recentBlockhash: blockhash,
                      instructions: plan.transaction.instructions,
                    }).compileToV0Message([plan.lookupTable]),
                  );
                });
                if (confirmed && unsubmitted !== null) {
                  setQuantity(unsubmitted);
                  setLeft(
                    unsubmitted
                      ? t(
                          "{count} contracts remain unsubmitted. Refresh and explicitly retry.",
                          { count: unsubmitted },
                        )
                      : "",
                  );
                }
              })();
            }}
          >
            <label>
              {t("Side")}
              <select
                disabled={s.busy}
                value={side}
                onChange={(e) => setSide(e.target.value as Side)}
              >
                <option value="bid">{t("Buy")}</option>
                <option value="ask">{t("Sell")}</option>
              </select>
            </label>
            <label>
              {t("Limit price ({symbol})", {
                symbol: d.metadata?.quoteSymbol ?? t("collateral"),
              })}
              <input
                required
                inputMode="decimal"
                disabled={s.busy}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
            <label>
              {t("Contracts (multiples of {lot})", {
                lot: d.market.terms.quantityLot.toString(),
              })}
              <input
                required
                inputMode="numeric"
                disabled={s.busy}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>
            <p>
              {t(
                "Taker fee: {fee}%. Maker orders pay no fee. Fills execute at maker prices; any safe remainder rests at your limit.",
                { fee: d.feeBps / 100 },
              )}
            </p>
            <button
              disabled={!ready || !trading || !d.book || !d.position || !d.cash}
            >
              {t("Review in wallet")}
            </button>
            {left && s.signature && <p role="status">{left}</p>}
          </form>
        </div>
      </div>
      <p>
        {t("Available collateral")}:{" "}
        {d.cash
          ? readableAmount(d.cash.free, d.decimals)
          : t("Account not initialized")}
        . <Link href="/wallet">{t("Deposit or withdraw in Wallet →")}</Link>
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
          {t("Initialize trading accounts")}
        </button>
      )}
      <h3>{t("Your open orders")}</h3>
      {rows
        .filter((r) =>
          r.account.owner.equals(s.wallet?.publicKey ?? PROGRAM_ID),
        )
        .map((r) => (
          <p key={r.publicKey.toBase58()}>
            {t(
              sideOf(r.account) === "bid"
                ? "Buy {quantity} at {price}"
                : "Sell {quantity} at {price}",
              {
                quantity: r.account.remainingQuantity.toString(),
                price: readableAmount(r.account.price, d.decimals),
              },
            )}{" "}
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
              {t("Cancel")}
            </button>
          </p>
        ))}
    </section>
  );
}
