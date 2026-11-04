"use client";

import { useEffect, useMemo, useState } from "react";
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
  getTidebookAccounts,
  getTidebookProgram,
  getOwnedTokenBalance,
  findOwnedTokenAccount,
  deriveVaultAuthorityPda,
  parseTokenAmount,
  TOKEN_PROGRAM_ID,
  transactionExplorerUrl,
} from "../lib/tidebook";

interface PositionProps {
  market: PublicKey;
  collateralMint: PublicKey;
  collateralVault: PublicKey;
  status: string;
  payoutPerContract: BN;
  collateralSymbol: string;
}

/** Public market terms stay visible; the wallet's private action state resets
 * on wallet, market or RPC changes so an old response cannot show another
 * wallet's ledger or initialization result. Account balances themselves are public. */
export function PredictionPositionPanel(props: PositionProps) {
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Wallet auto-connect may already differ from the server. Keep the first
  // client render identical to SSR, as with the shared wallet button.
  if (!mounted) {
    return (
      <section className="access-card">
        <h2>Your position</h2>
        <p>Loading wallet…</p>
      </section>
    );
  }
  if (!wallet) {
    return (
      <section className="access-card">
        <h2>Your position</h2>
        <p>Connect a wallet to view or initialize your prediction position.</p>
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
  wallet,
}: PositionProps & {
  wallet: NonNullable<ReturnType<typeof useAnchorWallet>>;
}) {
  const { connection } = useConnection();
  const program = useMemo(
    () => getTidebookProgram(connection, wallet),
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
  const [resultKind, setResultKind] = useState<
    "position" | "deposit" | "withdraw" | "split" | "merge"
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
        const accounts = getTidebookAccounts(program);
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
  }, [program, positionAddress, market, wallet.publicKey, refresh]);

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
      aria-busy={loading || walletLoading || pending}
    >
      <div className="market-list-heading">
        <h2>Your position</h2>
        <button
          className="text-button"
          type="button"
          disabled={loading || walletLoading || pending}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh position
        </button>
      </div>
      {loading && <p role="status">Loading your position…</p>}
      {error && (
        <p className="access-denied" role="alert">
          {error}
        </p>
      )}
      {actionError && (
        <p className="access-denied" role="alert">
          {actionError}
        </p>
      )}
      {!loading && !error && position && (
        <>
          <dl className="market-metadata">
            {balances.map(([label, amount]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{amount}</dd>
              </div>
            ))}
          </dl>
          <a
            className="market-explorer-link"
            href={accountExplorerUrl(positionAddress)}
            target="_blank"
            rel="noreferrer"
          >
            View position account ↗
          </a>
          <form
            className="market-create-form prediction-deposit"
            onSubmit={(event) => {
              event.preventDefault();
              void fund();
            }}
          >
            <p>
              {collateralSymbol} in wallet:{" "}
              {walletLoading
                ? "Loading…"
                : walletBalance !== null
                  ? formatAtomicAmount(walletBalance, decimals)
                  : "Unavailable"}
            </p>
            {walletError && (
              <p className="access-denied" role="alert">
                {walletError}
              </p>
            )}
            <label>
              Collateral action
              <select
                value={cashAction}
                onChange={(event) =>
                  setCashAction(event.target.value as "deposit" | "withdraw")
                }
                disabled={pending}
              >
                <option value="deposit">Deposit to market</option>
                <option value="withdraw">Withdraw to wallet</option>
              </select>
            </label>
            <label>
              Amount ({collateralSymbol})
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
                  ? "Depositing credits available collateral; it does not create YES/NO positions."
                  : "Withdraw available collateral only. Funds in orders and outcome backing cannot be withdrawn.")}
            </small>
            {!PREDICTION_FUNDING_ENABLED && (
              <p>
                Funding and pair conversion await deployment of the updated
                program.
              </p>
            )}
            {!acceptsDeposits && cashAction === "deposit" && (
              <p>This market no longer accepts new collateral deposits.</p>
            )}
            <button
              className="primary-button"
              type="submit"
              disabled={!canFund}
            >
              {pending
                ? "Confirming…"
                : cashAction === "deposit"
                  ? "Deposit collateral"
                  : "Withdraw collateral"}
            </button>
          </form>
          <form
            className="market-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void convert();
            }}
          >
            <h3>YES / NO pairs</h3>
            <p>
              One {collateralSymbol} backs one YES plus one NO contract.
              Splitting reserves collateral; merging an available pair returns
              it to your available balance.
            </p>
            <label>
              Pair action
              <select
                value={setAction}
                onChange={(event) =>
                  setSetAction(event.target.value as "split" | "merge")
                }
                disabled={pending}
              >
                <option value="split">Split collateral into YES + NO</option>
                <option value="merge">Merge YES + NO into collateral</option>
              </select>
            </label>
            <label>
              Whole pairs
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
                (setCollateral
                  ? `${setAction === "split" ? "Reserves" : "Releases"} ${formatAtomicAmount(setCollateral, decimals)} ${collateralSymbol}.`
                  : "Splitting requires an open market before close. Merge available pairs while open, frozen or awaiting resolution.")}
            </small>
            {marketState && (
              <p>
                Reserved backing:{" "}
                {formatAtomicAmount(marketState.backingReserve, decimals)}{" "}
                {collateralSymbol}
              </p>
            )}
            <button
              className="primary-button"
              type="submit"
              disabled={!canConvert}
            >
              {pending
                ? "Confirming…"
                : setAction === "split"
                  ? "Create YES + NO pairs"
                  : "Merge available pairs"}
            </button>
          </form>
        </>
      )}
      {!loading && !error && !position && (
        <>
          <p>
            Initialize your position to create your market ledger. You pay SOL
            account rent; no collateral is deposited.
          </p>
          {!PREDICTION_DRAFTS_ENABLED && (
            <p>
              Position initialization is awaiting the matching program
              deployment.
            </p>
          )}
          <button
            className="primary-button"
            type="button"
            disabled={!PREDICTION_DRAFTS_ENABLED || pending || !!signature}
            onClick={() => void initialize()}
          >
            {pending
              ? "Initializing…"
              : signature
                ? "Confirmed; refresh to load"
                : "Initialize position"}
          </button>
        </>
      )}
      {signature && (
        <p className="transaction-message transaction-success">
          {resultKind === "deposit"
            ? "Collateral deposited."
            : resultKind === "withdraw"
              ? "Collateral withdrawn."
              : resultKind === "split"
                ? "YES + NO pairs created."
                : resultKind === "merge"
                  ? "Pairs merged into available collateral."
                  : "Position initialized."}{" "}
          <a
            href={transactionExplorerUrl(signature)}
            target="_blank"
            rel="noreferrer"
          >
            View transaction ↗
          </a>
        </p>
      )}
      <p>
        Market opening, outcome trading and redemption will be added in later
        milestones. Draft markets cannot create pairs.
      </p>
    </section>
  );
}
