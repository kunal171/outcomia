"use client";
import { useI18n } from "./preferences-provider";

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
  getOutcomiaProgram,
  getOutcomiaReadProgram,
  deriveAdminRecordPda,
  deriveProtocolConfigPda,
  parseTokenAmount,
  TOKEN_PROGRAM_ID,
  transactionExplorerUrl,
  getOutcomiaAccounts,
} from "../lib/outcomia";
import { derivePredictionPositionPda } from "../lib/prediction";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { readableAmount, inversePrice } from "../lib/market-display";
import { SharedAssetFunds } from "./shared-wallet";
import { PredictionTradeWorkspace } from "./prediction/trade-workspace";
import { SharedOpenOrders } from "./shared-open-orders";
import { useProtocolRole } from "./protocol-role-provider";
interface Props {
  /** Spot keeps its existing combined view; predictions split trading from order management. */
  view?: "all" | "trade" | "orders";
  refreshKey?: number;
  market: PublicKey;
  onChanged?: () => void;
  tradingOpen: boolean;
  /** Data refresh can pause new orders without changing the displayed lifecycle. */
  entryDisabled?: boolean;
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
  const { t } = useI18n();

  const wallet = useAnchorWallet(),
    { connection } = useConnection(),
    role = useProtocolRole();
  const program = useMemo(
    () => getOutcomiaReadProgram(connection),
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
  const [fundingOpen, setFundingOpen] = useState(false);
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
  }, [program, props.market, revision, props.refreshKey]);
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
      const p = getOutcomiaProgram(connection, wallet),
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
              !(await getOutcomiaAccounts(p).predictionPosition.fetchNullable(
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
              t("{value0} was not posted: {value1}.", {
                value0: readableAmount(
                  plan.remaining,
                  props.kind === "prediction" ? 0 : props.baseDecimals!,
                ),
                value1:
                  plan.stopReason === "zero-notional"
                    ? t("its value is below one quote atom")
                    : t(
                        "the three-maker limit was reached; refresh before retrying",
                      ),
              }),
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
    !!wallet?.publicKey.equals(props.authority) &&
    !role.loading &&
    !role.error &&
    (role.role === "admin" || role.role === "super-admin");
  const feedback = (
    <div className="prediction-feedback">
      {issue && <p role="alert">{t(issue ?? "")}</p>}
      {notice && signature && <p role="status">{t(notice ?? "")}</p>}
      {signature && (
        <a
          href={transactionExplorerUrl(signature)}
          target="_blank"
          rel="noreferrer"
        >
          {t("View transaction ↗")}
        </a>
      )}
    </div>
  );
  const openOrders = (
    <SharedOpenOrders
      snapshot={snapshot}
      loaded={loaded}
      owner={wallet?.publicKey}
      pending={pending}
      decimals={props.quoteDecimals}
      quantityDecimals={props.kind === "prediction" ? 0 : props.baseDecimals!}
      symbol={props.quoteSymbol}
      onCancel={(order) => void transact("cancel", order)}
    />
  );
  const fees =
    snapshot && role.role === "super-admin" ? (
      <details className="prediction-fees">
        <summary>{t("Protocol fees")}</summary>
        <p>
          {`${readableAmount(snapshot.book.accruedQuoteFees, props.quoteDecimals)} ${props.quoteSymbol}`}
        </p>
        <button
          type="button"
          disabled={pending || snapshot.book.accruedQuoteFees.isZero()}
          onClick={() => void transact("fees")}
        >
          {t("Withdraw earned fees")}
        </button>
      </details>
    ) : null;

  // Each view owns its markup; all signing and refreshed queue reads stay above.
  if (props.view === "orders")
    return (
      <section className="shared-market shared-orders-view">
        <div className="shared-orders-toolbar">
          <button
            type="button"
            disabled={pending}
            onClick={() => setRevision((v) => v + 1)}
          >
            {t("Refresh orders")}
          </button>
        </div>
        {openOrders}
        {feedback}
        {fees}
      </section>
    );
  if (props.kind === "prediction" && !props.tradingOpen)
    return (
      <div className="prediction-closed-feedback">
        {pending && (
          <p role="status">{t("Waiting for transaction confirmation…")}</p>
        )}
        {feedback}
      </div>
    );
  if (props.kind === "prediction")
    return (
      <PredictionTradeWorkspace
        snapshot={snapshot}
        loaded={loaded}
        failed={!!issue}
        pending={pending}
        disabled={!!props.entryDisabled || !props.tradingOpen}
        connected={!!wallet}
        symbol={props.quoteSymbol}
        decimals={props.quoteDecimals}
        outcome={outcome === "no" ? "no" : "yes"}
        side={side}
        price={price}
        quantity={quantity}
        onOutcome={setOutcome}
        onSide={setSide}
        onPrice={setPrice}
        onQuantity={setQuantity}
        onSubmit={() => void transact("trade")}
        onInitialize={
          canSetup && props.tradingOpen
            ? () => void transact("initialize")
            : undefined
        }
        feedback={feedback}
        funding={
          <details
            className="prediction-funding"
            onToggle={(event) =>
              event.currentTarget.open && setFundingOpen(true)
            }
          >
            <summary>
              {t("Funds · {value0}", { value0: props.quoteSymbol })}
            </summary>
            {fundingOpen && (
              <SharedAssetFunds
                key={`quote:${revision}`}
                mint={props.quoteMint}
                decimals={props.quoteDecimals}
                symbol={props.quoteSymbol}
                onChanged={() => setRevision((v) => v + 1)}
              />
            )}
          </details>
        }
      />
    );

  const orders = (snapshot?.orders ?? []).filter(
    ({ account }) => "open" in account.status && "spot" in account.outcome,
  );
  const bid = snapshot?.book.bestPrices[0],
    ask = snapshot?.book.bestPrices[1];
  const quote = bid && ask ? bid.add(ask).divn(2) : (bid ?? ask);
  return (
    <section className="admin-card shared-market">
      <div className="section-heading">
        <h2>{t("Trade this pair")}</h2>
        <button
          type="button"
          disabled={pending}
          onClick={() => setRevision((v) => v + 1)}
        >
          {t("Refresh")}
        </button>
      </div>
      {!props.tradingOpen && (
        <p role="status">
          {t(
            "Trading is closed. You can still cancel orders and withdraw free funds.",
          )}
        </p>
      )}
      {!loaded && !issue && <p>{t("Loading shared book…")}</p>}
      {loaded && !snapshot && (
        <p>
          {canSetup && props.tradingOpen ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => void transact("initialize")}
            >
              {t("Enable shared-wallet book")}
            </button>
          ) : (
            "The market creator has not enabled the shared book."
          )}
        </p>
      )}
      {quote && (
        <div className="market-rate-card">
          <div>
            <h3>
              {`1 ${props.baseSymbol} ≈ ${readableAmount(quote, props.quoteDecimals)}  ${props.quoteSymbol}`}
            </h3>
            <p>
              {`1 ${props.quoteSymbol} ≈ ${inversePrice(quote, props.quoteDecimals)} ${props.baseSymbol}`}
            </p>
            <p>
              {t(
                "Indicative shared-book quote {value0}; execution prices and fees can differ.",
                { value0: bid && ask ? t("(midpoint)") : t("(one side only)") },
              )}
            </p>
          </div>
        </div>
      )}
      {snapshot && (
        <>
          <div className="shared-depth">
            {(["bid", "ask"] as const).map((value) => (
              <div key={value}>
                <h3>{value === "bid" ? t("Buy orders") : t("Sell orders")}</h3>
                {orders
                  .filter(({ account }) => value in account.side)
                  .sort((a, b) =>
                    value === "bid"
                      ? b.account.price.cmp(a.account.price)
                      : a.account.price.cmp(b.account.price),
                  )
                  .map(({ publicKey, account }) => (
                    <p key={publicKey.toBase58()}>
                      {`${readableAmount(account.price, props.quoteDecimals)} ${props.quoteSymbol} × ${readableAmount(
                        account.remainingQuantity,
                        props.baseDecimals!,
                      )}`}
                    </p>
                  ))}
              </div>
            ))}
          </div>
          {wallet ? (
            <>
              <label>
                {t("Buy or sell")}
                <select
                  value={side}
                  disabled={pending}
                  onChange={(event) => setSide(event.target.value as Side)}
                >
                  <option value="bid">
                    {t("Buy {value0}", { value0: props.baseSymbol })}
                  </option>
                  <option value="ask">
                    {t("Sell {value0}", { value0: props.baseSymbol })}
                  </option>
                </select>
              </label>
              <label>
                {t("Price ({value0} per {value1})", {
                  value0: props.quoteSymbol,
                  value1: props.baseSymbol,
                })}
                <input
                  inputMode="decimal"
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  disabled={pending}
                />
              </label>
              <label>
                {t("Quantity ({value0})", { value0: props.baseSymbol })}
                <input
                  inputMode="decimal"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  disabled={pending}
                />
              </label>
              <button
                type="button"
                disabled={
                  pending ||
                  !loaded ||
                  !props.tradingOpen ||
                  !!props.entryDisabled ||
                  !price ||
                  !quantity
                }
                onClick={() => void transact("trade")}
              >
                {pending
                  ? t("Confirm in wallet…")
                  : `${side === "bid" ? t("Buy") : t("Sell")} ${props.baseSymbol}`}
              </button>
            </>
          ) : (
            <p>{t("Connect a wallet to trade.")}</p>
          )}
          {openOrders}
        </>
      )}
      {feedback}
      {fees}
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
