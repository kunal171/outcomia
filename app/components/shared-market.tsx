"use client";
/** Public shared order book and signed owner actions. Old queues are separate recovery paths. */
import { useEffect, useMemo, useState } from "react";
import { AnchorProvider, BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  readSharedBook,
  assertSharedTransactionFits,
  buildSharedTrade,
  cancelShared,
  sharedBookPda,
  sharedAccounts,
  SHARED_BALANCES_ENABLED,
  variant,
  assetCustody,
  assetAuthorityPda,
  assetVaultPda,
  type Outcome,
  type Side,
  type SharedSnapshot,
} from "../lib/shared";
import {
  getTidebookProgram,
  getTidebookReadProgram,
  deriveAdminRecordPda,
  deriveProtocolConfigPda,
  parseTokenAmount,
  TOKEN_PROGRAM_ID,
  transactionExplorerUrl,
  getTidebookAccounts,
} from "../lib/tidebook";
import { derivePredictionPositionPda } from "../lib/prediction";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { readableAmount, inversePrice } from "../lib/market-display";
import { SharedAssetFunds } from "./shared-wallet";
import { useProtocolRole } from "./protocol-role-provider";
interface Props {
  market: PublicKey;
  onChanged?: () => void;
  tradingOpen: boolean;
  kind: "spot" | "prediction";
  authority: PublicKey;
  quoteMint: PublicKey;
  quoteDecimals: number;
  quoteSymbol: string;
  baseMint?: PublicKey;
  baseDecimals?: number;
  baseSymbol?: string;
}
export function SharedMarket(props: Props) {
  const { connection } = useConnection(),
    wallet = useAnchorWallet();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!SHARED_BALANCES_ENABLED || !mounted) return null;
  return (
    <Market
      key={`${connection.rpcEndpoint}:${wallet?.publicKey ?? "reader"}:${props.market}`}
      {...props}
    />
  );
}
function Market(props: Props) {
  const wallet = useAnchorWallet(),
    { connection } = useConnection(),
    role = useProtocolRole();
  const program = useMemo(
    () => getTidebookReadProgram(connection),
    [connection],
  );
  const [snapshot, setSnapshot] = useState<SharedSnapshot | null>(null),
    [loaded, setLoaded] = useState(false),
    [issue, setIssue] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [revision, setRevision] = useState(0),
    [signature, setSignature] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [side, setSide] = useState<Side>("bid"),
    [outcome, setOutcome] = useState<Outcome>(
      props.kind === "spot" ? "spot" : "yes",
    ),
    [price, setPrice] = useState(""),
    [quantity, setQuantity] = useState("");
  useEffect(() => {
    let dead = false;
    setLoaded(false);
    void readSharedBook(program, props.market)
      .then((s) => {
        if (!dead) {
          setSnapshot(s);
          setLoaded(true);
          setIssue(null);
        }
      })
      .catch((e) => {
        if (!dead) setIssue(String(e));
      });
    return () => {
      dead = true;
    };
  }, [program, props.market, revision]);
  async function transact(
    action: "initialize" | "trade" | "cancel" | "fees",
    order?: PublicKey,
  ) {
    if (!wallet) return;
    setPending(true);
    setIssue(null);
    setSignature(null);
    setNotice("");
    try {
      const p = getTidebookProgram(connection, wallet),
        tx = new Transaction();
      if (action === "initialize")
        tx.add(
          await p.methods
            .initializeSharedBook(variant(props.kind))
            .accountsPartial({
              authority: wallet.publicKey,
              adminRecord: deriveAdminRecordPda(wallet.publicKey),
              market: props.market,
              book: sharedBookPda(props.market),
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
        );
      else {
        const current = await readSharedBook(p, props.market);
        if (!current) throw new Error("Shared book is not initialized");
        if (action === "fees") {
          const destination = getAssociatedTokenAddressSync(
            props.quoteMint,
            wallet.publicKey,
          );
          tx.add(
            createAssociatedTokenAccountIdempotentInstruction(
              wallet.publicKey,
              destination,
              wallet.publicKey,
              props.quoteMint,
            ),
          );
          tx.add(
            await p.methods
              .withdrawSharedFees(current.book.accruedQuoteFees)
              .accountsPartial({
                superAdmin: wallet.publicKey,
                protocolConfig: deriveProtocolConfigPda(),
                book: current.key,
                mint: props.quoteMint,
                destination,
                vaultAuthority: assetAuthorityPda(props.quoteMint),
                assetVault: assetVaultPda(props.quoteMint),
                tokenProgram: TOKEN_PROGRAM_ID,
              })
              .instruction(),
          );
        } else if (action === "cancel")
          tx.add(await cancelShared(p, current, wallet.publicKey, order!));
        else {
          // Initialize each mint ledger once; it is reused across every subsequent market.
          const mints =
            props.kind === "spot"
              ? [props.baseMint!, props.quoteMint]
              : [props.quoteMint];
          for (const mint of mints) {
            const c = assetCustody(wallet.publicKey, mint);
            if (
              !(await sharedAccounts(p).assetBalance.fetchNullable(
                c.assetBalance,
              ))
            )
              tx.add(
                await p.methods
                  .initializeAssetBalance()
                  .accountsPartial({
                    ...c,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                  })
                  .instruction(),
              );
          }
          if (props.kind === "prediction") {
            const position = derivePredictionPositionPda(
              props.market,
              wallet.publicKey,
            );
            if (
              !(await getTidebookAccounts(p).predictionPosition.fetchNullable(
                position,
              ))
            )
              tx.add(
                await p.methods
                  .initializePredictionPosition()
                  .accountsPartial({
                    owner: wallet.publicKey,
                    market: props.market,
                    position,
                    systemProgram: SystemProgram.programId,
                  })
                  .instruction(),
              );
          }
          const plan = await buildSharedTrade(
            p,
            current,
            wallet.publicKey,
            outcome,
            side,
            parseTokenAmount(price, props.quoteDecimals, "Price"),
            parseTokenAmount(
              quantity,
              props.kind === "prediction" ? 0 : props.baseDecimals!,
              "Quantity",
            ),
          );
          tx.add(...plan.instructions);
          if (plan.remaining.gtn(0))
            setNotice(
              `${readableAmount(plan.remaining, props.kind === "prediction" ? 0 : props.baseDecimals!)} was not posted: ${plan.stopReason === "zero-notional" ? "its value is below one quote atom" : "the three-maker limit was reached; refresh before retrying"}.`,
            );
        }
      }
      assertSharedTransactionFits(tx, wallet.publicKey);
      setSignature(await (p.provider as AnchorProvider).sendAndConfirm(tx));
      setRevision((v) => v + 1);
      props.onChanged?.();
      if (action === "trade") {
        setPrice("");
        setQuantity("");
      }
    } catch (e) {
      setIssue(e instanceof Error ? e.message : String(e));
      setNotice("");
    } finally {
      setPending(false);
    }
  }
  const canSetup =
    wallet?.publicKey.equals(props.authority) &&
    (role.role === "admin" || role.role === "super-admin");
  const orders = (snapshot?.orders ?? []).filter(
    (r) => "open" in r.account.status && outcome in r.account.outcome,
  );
  const slot = outcome === "no" ? 2 : 0,
    bid = snapshot?.book.bestPrices[slot],
    ask = snapshot?.book.bestPrices[slot + 1];
  const quote = bid && ask ? bid.add(ask).divn(2) : (bid ?? ask);
  const quantities = (n: BN) =>
    readableAmount(n, props.kind === "prediction" ? 0 : props.baseDecimals!);
  return (
    <section className="admin-card shared-market">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Shared-wallet trading</span>
          <h2>
            {props.kind === "prediction" ? "Trade YES / NO" : "Trade this pair"}
          </h2>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => setRevision((v) => v + 1)}
        >
          Refresh
        </button>
      </div>
      {!props.tradingOpen && (
        <p role="status">
          Trading is closed. You can still cancel shared orders and withdraw
          free funds.
        </p>
      )}
      <p>
        Uses your shared {props.quoteSymbol} balance. Legacy market deposits and
        orders remain below for recovery.
      </p>
      {!loaded && !issue && <p>Loading shared book…</p>}
      {loaded && !snapshot && (
        <p>
          {canSetup ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => void transact("initialize")}
            >
              Enable shared-wallet book
            </button>
          ) : (
            "The market creator has not enabled the shared book."
          )}
        </p>
      )}
      {props.kind === "prediction" && (
        <label>
          Contract
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as Outcome)}
          >
            <option value="yes">YES</option>
            <option value="no">NO</option>
          </select>
        </label>
      )}
      {snapshot && quote && (
        <div className="market-rate-card">
          <div>
            <h3>
              1{" "}
              {outcome === "spot"
                ? props.baseSymbol
                : outcome.toUpperCase() + " contract"}{" "}
              ≈ {readableAmount(quote, props.quoteDecimals)} {props.quoteSymbol}
            </h3>
            {props.kind === "spot" && (
              <p>
                1 {props.quoteSymbol} ≈{" "}
                {inversePrice(quote, props.quoteDecimals)} {props.baseSymbol}
              </p>
            )}
            <p>
              Indicative shared-book quote
              {bid && ask ? " (midpoint)" : " (one side only)"}; execution
              prices and fees can differ.
            </p>
          </div>
        </div>
      )}
      {snapshot && (
        <>
          <div className="shared-depth">
            <div>
              <h3>Buy orders</h3>
              {orders
                .filter((r) => "bid" in r.account.side)
                .sort((a, b) => b.account.price.cmp(a.account.price))
                .map((r) => (
                  <p key={r.publicKey.toBase58()}>
                    {readableAmount(r.account.price, props.quoteDecimals)}{" "}
                    {props.quoteSymbol} ×{" "}
                    {quantities(r.account.remainingQuantity)}
                  </p>
                ))}
            </div>
            <div>
              <h3>Sell orders</h3>
              {orders
                .filter((r) => "ask" in r.account.side)
                .sort((a, b) => a.account.price.cmp(b.account.price))
                .map((r) => (
                  <p key={r.publicKey.toBase58()}>
                    {readableAmount(r.account.price, props.quoteDecimals)}{" "}
                    {props.quoteSymbol} ×{" "}
                    {quantities(r.account.remainingQuantity)}
                  </p>
                ))}
            </div>
          </div>
          {wallet ? (
            <>
              <label>
                Action
                <select
                  value={side}
                  disabled={pending}
                  onChange={(e) => setSide(e.target.value as Side)}
                >
                  <option value="bid">
                    Buy{" "}
                    {outcome === "spot"
                      ? props.baseSymbol
                      : outcome.toUpperCase()}
                  </option>
                  <option value="ask">
                    Sell{" "}
                    {outcome === "spot"
                      ? props.baseSymbol
                      : outcome.toUpperCase()}
                  </option>
                </select>
              </label>
              <label>
                Price ({props.quoteSymbol} per{" "}
                {props.kind === "prediction" ? "contract" : props.baseSymbol})
                <input
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  disabled={pending}
                />
              </label>
              <label>
                Quantity (
                {props.kind === "prediction"
                  ? "whole contracts"
                  : props.baseSymbol}
                )
                <input
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  disabled={pending}
                />
              </label>
              <button
                type="button"
                disabled={pending || !props.tradingOpen || !price || !quantity}
                onClick={() => void transact("trade")}
              >
                {pending
                  ? "Confirm in wallet…"
                  : `${side === "bid" ? "Buy" : "Sell"} ${outcome === "spot" ? props.baseSymbol : outcome.toUpperCase()}`}
              </button>
              <p>
                Up to three FIFO makers fill at their resting price. A
                noncrossing remainder rests at your limit. Fees are charged on
                each fill.
              </p>
              <h3>Your open shared orders</h3>
              {snapshot.orders
                .filter(
                  (r) =>
                    r.account.owner.equals(wallet.publicKey) &&
                    "open" in r.account.status,
                )
                .map((r) => (
                  <p key={r.publicKey.toBase58()}>
                    {Object.keys(r.account.outcome)[0].toUpperCase()} ·{" "}
                    {"bid" in r.account.side ? "Buy" : "Sell"} ·{" "}
                    {readableAmount(r.account.price, props.quoteDecimals)} ×{" "}
                    {quantities(r.account.remainingQuantity)}{" "}
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void transact("cancel", r.publicKey)}
                    >
                      Cancel
                    </button>
                  </p>
                ))}
            </>
          ) : (
            <p>Connect a wallet to trade.</p>
          )}
        </>
      )}
      {snapshot && role.role === "super-admin" && (
        <p>
          Shared-book fees:{" "}
          {readableAmount(snapshot.book.accruedQuoteFees, props.quoteDecimals)}{" "}
          {props.quoteSymbol}{" "}
          <button
            type="button"
            disabled={pending || snapshot.book.accruedQuoteFees.isZero()}
            onClick={() => void transact("fees")}
          >
            Withdraw earned fees
          </button>
        </p>
      )}
      {issue && <p role="alert">{issue}</p>}
      {notice && signature && <p role="status">{notice}</p>}
      {signature && (
        <a
          href={transactionExplorerUrl(signature)}
          target="_blank"
          rel="noreferrer"
        >
          View transaction ↗
        </a>
      )}
      <SharedAssetFunds
        key={`quote:${revision}`}
        mint={props.quoteMint}
        decimals={props.quoteDecimals}
        symbol={props.quoteSymbol}
        onChanged={() => setRevision((v) => v + 1)}
      />
      {props.baseMint && (
        <SharedAssetFunds
          key={`base:${revision}`}
          mint={props.baseMint}
          decimals={props.baseDecimals!}
          symbol={props.baseSymbol!}
          onChanged={() => setRevision((v) => v + 1)}
        />
      )}
    </section>
  );
}
