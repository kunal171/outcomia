"use client";
import { useI18n } from "./preferences-provider";

import {
  SHARED_BALANCES_ENABLED,
  PREDICTION_RESOLUTION_ENABLED,
} from "../lib/shared";

import { useEffect, useMemo, useState } from "react";
import { PredictionOrders } from "./prediction-orders";
import { PredictionMatchForm } from "./prediction-match-form";
import { AnchorProvider, BN } from "@anchor-lang/core";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  derivePredictionPositionPda,
  PREDICTION_DRAFTS_ENABLED,
  PREDICTION_FUNDING_ENABLED,
  validatePredictionDepositAmount,
  validatePredictionWithdrawalAmount,
  validatePredictionCompleteSet,
  predictionStatus,
  type PredictionMarketAccount,
  type PredictionPositionAccount,
} from "../lib/prediction";
import {
  accountExplorerUrl,
  formatAtomicAmount,
  getOutcomiaAccounts,
  getOutcomiaProgram,
  getOwnedTokenBalance,
  findOwnedTokenAccount,
  deriveVaultAuthorityPda,
  parseTokenAmount,
  TOKEN_PROGRAM_ID,
  transactionExplorerUrl,
} from "../lib/outcomia";

interface PositionProps {
  market: PublicKey;
  collateralMint: PublicKey;
  collateralVault: PublicKey;
  status: string;
  payoutPerContract: BN;
  collateralSymbol: string;
  onOrderPlaced: () => void;
}

/** Public market terms stay visible; the wallet's private action state resets
 * on wallet, market or RPC changes so an old response cannot show another
 * wallet's ledger or initialization result. Account balances themselves are public. */
export function PredictionPositionPanel(props: PositionProps) {
  const { t } = useI18n();

  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Wallet auto-connect may already differ from the server. Keep the first
  // client render identical to SSR, as with the shared wallet button.
  if (!mounted) {
    return (
      <section className="access-card">
        <h2>
          {SHARED_BALANCES_ENABLED
            ? t("Legacy cash & outcome recovery")
            : t("Your position")}
        </h2>
        <p>{t("Loading wallet…")}</p>
      </section>
    );
  }
  if (!wallet) {
    return (
      <section className="access-card">
        <h2>
          {SHARED_BALANCES_ENABLED
            ? t("Legacy cash & outcome recovery")
            : t("Your position")}
        </h2>
        <p>
          {t(
            "Connect a wallet to view or initialize your prediction position.",
          )}
        </p>
      </section>
    );
  }
  return (
    <ConnectedPosition
      key={`${connection.rpcEndpoint}:${props.market.toBase58()}:${wallet.publicKey.toBase58()}`}
      {...props}
      wallet={wallet}
    />
  );
}

function ConnectedPosition({
  market,
  collateralMint,
  collateralVault,
  status,
  payoutPerContract,
  collateralSymbol,
  onOrderPlaced,
  wallet,
}: PositionProps & {
  wallet: NonNullable<ReturnType<typeof useAnchorWallet>>;
}) {
  const { t } = useI18n();

  const { connection } = useConnection();
  const program = useMemo(
    () => getOutcomiaProgram(connection, wallet),
    [connection, wallet],
  );
  const positionAddress = useMemo(
    () => derivePredictionPositionPda(market, wallet.publicKey),
    [market, wallet.publicKey],
  );
  const [position, setPosition] = useState<PredictionPositionAccount | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [lastOrder, setLastOrder] = useState<PublicKey | null>(null);
  const [resultKind, setResultKind] = useState<
    | "position"
    | "deposit"
    | "withdraw"
    | "split"
    | "merge"
    | "order"
    | "cancel"
    | "match"
  >("position");
  const [actionError, setActionError] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<BN | null>(null);
  const [walletLoading, setWalletLoading] = useState(true);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [cashAction, setCashAction] = useState<"deposit" | "withdraw">(
    "deposit",
  );
  const [setAction, setSetAction] = useState<"split" | "merge">("split");
  const [quantity, setQuantity] = useState("");
  const [marketState, setMarketState] =
    useState<PredictionMarketAccount | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const timer = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    async function load() {
      try {
        const accounts = getOutcomiaAccounts(program);
        const [ledger, terms] = await Promise.all([
          accounts.predictionPosition.fetchNullable(positionAddress),
          accounts.predictionMarket.fetchNullable(market),
        ]);
        if (!terms)
          throw new Error("Prediction market was not found on this network");
        if (
          ledger &&
          (!ledger.market.equals(market) ||
            !ledger.owner.equals(wallet.publicKey))
        ) {
          throw new Error("Position does not belong to this wallet and market");
        }
        if (!canceled) {
          setPosition(ledger);
          setMarketState(terms);
        }
      } catch (cause) {
        // A failed RPC read is not evidence that the ledger is missing.
        if (!canceled)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load your position",
          );
      } finally {
        if (!canceled) setLoading(false);
      }
    }
    void load();
    return () => {
      canceled = true;
    };
  }, [program, positionAddress, market, wallet.publicKey, status, refresh]);

  useEffect(() => {
    let canceled = false;
    setWalletLoading(true);
    setWalletBalance(null);
    setWalletError(null);
    getOwnedTokenBalance(connection, wallet.publicKey, collateralMint)
      .then((balance) => {
        if (!canceled) setWalletBalance(balance);
      })
      .catch((cause) => {
        if (!canceled)
          setWalletError(
            cause instanceof Error
              ? cause.message
              : "Unable to load wallet collateral",
          );
      })
      .finally(() => {
        if (!canceled) setWalletLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [connection, wallet.publicKey, collateralMint, refresh]);

  async function initialize() {
    if (
      !PREDICTION_DRAFTS_ENABLED ||
      loading ||
      pending ||
      position ||
      error ||
      signature
    )
      return;
    setPending(true);
    setActionError(null);
    try {
      const ix = await program.methods
        .initializePredictionPosition()
        .accounts({
          owner: wallet.publicKey,
          market,
          position: positionAddress,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const confirmed = await (
        program.provider as AnchorProvider
      ).sendAndConfirm(new Transaction().add(ix));
      setSignature(confirmed);
      setResultKind("position");
      // Read authoritative account data after confirmation rather than
      // inventing a client-side ledger with assumed balances.
      setRefresh((value) => value + 1);
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Position initialization failed",
      );
    } finally {
      setPending(false);
    }
  }

  // Initialization enforces payout_per_contract = 10^mint.decimals.
  // Derive precision from that scale without another mint RPC request.
  const decimals = payoutPerContract.toString().length - 1;
  let cashAmount: BN | null = null;
  let cashIssue: string | null = null;
  if (
    position &&
    amount.trim() &&
    !loading &&
    !error &&
    (cashAction === "withdraw" || (!walletLoading && !walletError))
  ) {
    try {
      const parsed = parseTokenAmount(amount, decimals, "Collateral amount");
      cashAmount =
        cashAction === "deposit"
          ? validatePredictionDepositAmount(
              parsed,
              walletBalance,
              position.collateralFree,
            )
          : validatePredictionWithdrawalAmount(parsed, position.collateralFree);
    } catch (cause) {
      cashIssue =
        cause instanceof Error ? cause.message : "Invalid collateral amount";
    }
  }
  const acceptsDeposits = ["draft", "open", "frozen", "proposed"].includes(
    marketState ? predictionStatus(marketState) : status,
  );
  const canFund =
    PREDICTION_FUNDING_ENABLED &&
    (cashAction === "withdraw" || acceptsDeposits) &&
    !!cashAmount &&
    !loading &&
    !pending &&
    !error;

  async function fund() {
    if (!canFund || !cashAmount || !position) return;
    setPending(true);
    setActionError(null);
    setSignature(null);
    try {
      // Wallet balance is aggregated for display. Each transfer uses one
      // owned source account; fragmentation is reported rather than guessed.
      const transaction = new Transaction();
      if (cashAction === "deposit") {
        const source = await findOwnedTokenAccount(
          connection,
          wallet.publicKey,
          collateralMint,
          cashAmount,
        );
        const ix = await program.methods
          .depositPredictionCollateral(cashAmount)
          .accounts({
            owner: wallet.publicKey,
            market,
            position: positionAddress,
            collateralMint,
            source,
            vaultAuthority: deriveVaultAuthorityPda(market),
            collateralVault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();
        transaction.add(ix);
      } else {
        // Creating the ATA idempotently handles empty/new wallets and the race
        // where another transaction creates it between reading and submitting.
        const destination = getAssociatedTokenAddressSync(
          collateralMint,
          wallet.publicKey,
        );
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            destination,
            wallet.publicKey,
            collateralMint,
          ),
        );
        transaction.add(
          await program.methods
            .withdrawPredictionCollateral(cashAmount)
            .accounts({
              owner: wallet.publicKey,
              market,
              position: positionAddress,
              collateralMint,
              destination,
              vaultAuthority: deriveVaultAuthorityPda(market),
              collateralVault,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        );
      }
      const confirmed = await (
        program.provider as AnchorProvider
      ).sendAndConfirm(transaction);
      setSignature(confirmed);
      setResultKind(cashAction);
      setAmount("");
      setRefresh((value) => value + 1);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Collateral transfer failed",
      );
    } finally {
      setPending(false);
    }
  }

  let validatedQuantity: BN | null = null;
  let setCollateral: BN | null = null;
  let setIssue: string | null = null;
  if (quantity.trim() && position && marketState && !loading && !error) {
    try {
      // Decimal collateral and whole contracts have deliberately separate parsers.
      if (!/^\d+$/.test(quantity.trim()))
        throw new Error("Enter a whole number of pairs");
      const parsed = new BN(quantity.trim());
      setCollateral = validatePredictionCompleteSet(
        parsed,
        position,
        marketState,
        setAction,
        new BN(now),
      );
      validatedQuantity = parsed;
    } catch (cause) {
      setIssue =
        cause instanceof Error ? cause.message : "Invalid pair quantity";
    }
  }
  const canConvert =
    PREDICTION_FUNDING_ENABLED &&
    !!validatedQuantity &&
    !pending &&
    !loading &&
    !error;
  async function convert() {
    if (!canConvert || !validatedQuantity) return;
    setPending(true);
    setActionError(null);
    setSignature(null);
    try {
      const method =
        setAction === "split"
          ? program.methods.splitPredictionCompleteSet(validatedQuantity)
          : program.methods.mergePredictionCompleteSet(validatedQuantity);
      const ix = await method
        .accounts({
          owner: wallet.publicKey,
          market,
          position: positionAddress,
        })
        .instruction();
      const confirmed = await (
        program.provider as AnchorProvider
      ).sendAndConfirm(new Transaction().add(ix));
      setSignature(confirmed);
      setResultKind(setAction);
      setQuantity("");
      // Refresh both ledger and reserve totals; never invent local balances.
      setRefresh((value) => value + 1);
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Complete-set conversion failed",
      );
    } finally {
      setPending(false);
    }
  }
  const balances = position
    ? [
        [
          `${collateralSymbol} available`,
          formatAtomicAmount(position.collateralFree, decimals),
        ],
        [
          `${collateralSymbol} in orders`,
          formatAtomicAmount(position.collateralLocked, decimals),
        ],
        ["YES available", position.yesFree.toString()],
        ["YES in orders", position.yesLocked.toString()],
        ["NO available", position.noFree.toString()],
        ["NO in orders", position.noLocked.toString()],
      ]
    : [];

  return (
    <section
      className="admin-card prediction-position"
      id="position"
      aria-busy={loading || walletLoading || pending}
    >
      <div className="market-list-heading">
        <h2>
          {SHARED_BALANCES_ENABLED
            ? t("Legacy cash & outcome recovery")
            : t("Your position")}
        </h2>
        <button
          className="text-button"
          type="button"
          disabled={loading || walletLoading || pending}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t("Refresh position")}
        </button>
      </div>
      {loading && <p role="status">{t("Loading your position…")}</p>}
      {error && (
        <p className="access-denied" role="alert">
          {t(error ?? "")}
        </p>
      )}
      {actionError && (
        <p className="access-denied" role="alert">
          {t(actionError ?? "")}
        </p>
      )}
      {!loading && !error && position && (
        <>
          <dl className="market-metadata prediction-balances">
            {balances.map(([label, amount]) => (
              <div key={label}>
                <dt>{t(label ?? "")}</dt>
                <dd>{amount}</dd>
              </div>
            ))}
          </dl>
          {!SHARED_BALANCES_ENABLED && (
            <PredictionMatchForm
              program={program}
              owner={wallet.publicKey}
              market={market}
              decimals={decimals}
              symbol={collateralSymbol}
              pending={pending}
              setPending={setPending}
              onMatched={(confirmed, order) => {
                setSignature(confirmed);
                setLastOrder(order);
                setResultKind("match");
                setRefresh((value) => value + 1);
                onOrderPlaced();
              }}
            />
          )}
          <PredictionOrders
            program={program}
            owner={wallet.publicKey}
            market={market}
            decimals={decimals}
            symbol={collateralSymbol}
            pending={pending}
            setPending={setPending}
            onCanceled={(confirmed) => {
              setSignature(confirmed);
              setLastOrder(null);
              setResultKind("cancel");
              setRefresh((value) => value + 1);
              onOrderPlaced();
            }}
          />
          <a
            className="market-explorer-link"
            href={accountExplorerUrl(positionAddress)}
            target="_blank"
            rel="noreferrer"
          >
            {t("View position account ↗")}
          </a>
          <form
            className="market-create-form prediction-deposit"
            onSubmit={(event) => {
              event.preventDefault();
              void fund();
            }}
          >
            <h3>{t("Deposit & withdraw")}</h3>
            <p>
              {t("{value0} in wallet: {value1}", {
                value0: collateralSymbol,
                value1: walletLoading
                  ? t("Loading…")
                  : walletBalance !== null
                    ? formatAtomicAmount(walletBalance, decimals)
                    : t("Unavailable"),
              })}
            </p>
            {walletError && (
              <p className="access-denied" role="alert">
                {t(walletError ?? "")}
              </p>
            )}
            <label>
              {t("Collateral action")}
              <select
                value={cashAction}
                onChange={(event) =>
                  setCashAction(event.target.value as "deposit" | "withdraw")
                }
                disabled={pending}
              >
                <option value="deposit">{t("Deposit to market")}</option>
                <option value="withdraw">{t("Withdraw to wallet")}</option>
              </select>
            </label>
            <label>
              {t("Amount ({value0})", { value0: collateralSymbol })}
              <input
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                disabled={pending}
                placeholder="10"
                aria-describedby="prediction-cash-issue"
              />
            </label>
            <small id="prediction-cash-issue">
              {cashIssue ??
                (cashAction === "deposit"
                  ? t(
                      "Depositing credits available collateral; it does not create YES/NO positions.",
                    )
                  : t(
                      "Withdraw available collateral only. Funds in orders and outcome backing cannot be withdrawn.",
                    ))}
            </small>
            {!PREDICTION_FUNDING_ENABLED && (
              <p>
                {t(
                  "Funding and pair conversion are disabled in this app configuration.",
                )}
              </p>
            )}
            {!acceptsDeposits && cashAction === "deposit" && (
              <p>
                {t("This market no longer accepts new collateral deposits.")}
              </p>
            )}
            <button
              className="primary-button"
              type="submit"
              disabled={!canFund}
            >
              {pending
                ? t("Confirming…")
                : cashAction === "deposit"
                  ? t("Deposit collateral")
                  : t("Withdraw collateral")}
            </button>
          </form>
          <form
            className="market-create-form prediction-convert"
            onSubmit={(event) => {
              event.preventDefault();
              void convert();
            }}
          >
            <h3>{t("YES / NO pairs")}</h3>
            <p>
              {t(
                "One {value0} backs one YES plus one NO contract. Splitting reserves collateral; merging an available pair returns it to your available balance.",
                { value0: collateralSymbol },
              )}
            </p>
            <label>
              {t("Pair action")}
              <select
                value={setAction}
                onChange={(event) =>
                  setSetAction(event.target.value as "split" | "merge")
                }
                disabled={pending}
              >
                <option value="split">
                  {t("Split collateral into YES + NO")}
                </option>
                <option value="merge">
                  {t("Merge YES + NO into collateral")}
                </option>
              </select>
            </label>
            <label>
              {t("Whole pairs")}
              <input
                inputMode="numeric"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                disabled={pending}
                placeholder="1"
                aria-describedby="prediction-set-issue"
              />
            </label>
            <small id="prediction-set-issue">
              {setIssue ??
                (setCollateral ? (
                  <>
                    {setAction === "split" ? t("Reserves") : t("Releases")}{" "}
                    {formatAtomicAmount(setCollateral, decimals)}{" "}
                    {collateralSymbol}
                    {"."}
                  </>
                ) : (
                  t(
                    "Splitting requires an open market before close. Merge available pairs while open, frozen or awaiting resolution.",
                  )
                ))}
            </small>
            {marketState && (
              <p>
                {t("Reserved backing: {value0} {value1}", {
                  value0: formatAtomicAmount(
                    marketState.backingReserve,
                    decimals,
                  ),
                  value1: collateralSymbol,
                })}
              </p>
            )}
            <button
              className="primary-button"
              type="submit"
              disabled={!canConvert}
            >
              {pending
                ? t("Confirming…")
                : setAction === "split"
                  ? t("Create YES + NO pairs")
                  : t("Merge available pairs")}
            </button>
          </form>
        </>
      )}
      {!loading && !error && !position && (
        <>
          <p>
            {t(
              "Initialize your position to create your market ledger. You pay SOL account rent; no collateral is deposited.",
            )}
          </p>
          {!PREDICTION_DRAFTS_ENABLED && (
            <p>
              {t(
                "Prediction position initialization is disabled in this app configuration.",
              )}
            </p>
          )}
          <button
            className="primary-button"
            type="button"
            disabled={!PREDICTION_DRAFTS_ENABLED || pending || !!signature}
            onClick={() => void initialize()}
          >
            {pending
              ? t("Initializing…")
              : signature
                ? t("Confirmed; refresh to load")
                : t("Initialize position")}
          </button>
        </>
      )}
      {signature && (
        <p className="transaction-message transaction-success">
          {resultKind === "deposit"
            ? t("Collateral deposited.")
            : resultKind === "withdraw"
              ? t("Collateral withdrawn.")
              : resultKind === "split"
                ? t("YES + NO pairs created.")
                : resultKind === "merge"
                  ? t("Pairs merged into available collateral.")
                  : resultKind === "order"
                    ? t("Prediction order placed.")
                    : resultKind === "cancel"
                      ? t("Prediction order canceled; unfilled funds released.")
                      : resultKind === "match"
                        ? t(
                            "Order transaction confirmed. Check your refreshed balances and orders for its result.",
                          )
                        : t("Position initialized.")}{" "}
          <a
            href={transactionExplorerUrl(signature)}
            target="_blank"
            rel="noreferrer"
          >
            {t("View transaction ↗")}
          </a>
          {lastOrder && (
            <>
              {" "}
              ·{" "}
              <a
                href={accountExplorerUrl(lastOrder)}
                target="_blank"
                rel="noreferrer"
              >
                {t("View order ↗")}
              </a>
            </>
          )}
        </p>
      )}
      <p>
        {t(
          "Cancel open orders to release their remaining funds. {value0} The creator must open a draft before trading begins.",
          {
            value0: PREDICTION_RESOLUTION_ENABLED
              ? t(
                  "Use the resolution panel above to redeem finalized free contracts into your shared wallet.",
                )
              : t("Resolution and claims require the next program upgrade."),
          },
        )}
      </p>
    </section>
  );
}
