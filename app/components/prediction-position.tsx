"use client";

import { useEffect, useMemo, useState } from "react";
import { AnchorProvider, type BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  derivePredictionPositionPda,
  PREDICTION_DRAFTS_ENABLED,
  PREDICTION_FUNDING_ENABLED,
  validatePredictionDepositAmount,
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
  const [resultKind, setResultKind] = useState<"position" | "deposit">(
    "position",
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<BN | null>(null);
  const [walletLoading, setWalletLoading] = useState(true);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    async function load() {
      try {
        const ledger =
          await getTidebookAccounts(program).predictionPosition.fetchNullable(
            positionAddress,
          );
        if (
          ledger &&
          (!ledger.market.equals(market) ||
            !ledger.owner.equals(wallet.publicKey))
        ) {
          throw new Error("Position does not belong to this wallet and market");
        }
        if (!canceled) setPosition(ledger);
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
  let depositAmount: BN | null = null;
  let depositIssue: string | null = null;
  if (
    position &&
    amount.trim() &&
    !loading &&
    !walletLoading &&
    !error &&
    !walletError
  ) {
    try {
      depositAmount = validatePredictionDepositAmount(
        parseTokenAmount(amount, decimals, "Deposit amount"),
        walletBalance,
        position.collateralFree,
      );
    } catch (cause) {
      depositIssue =
        cause instanceof Error ? cause.message : "Invalid deposit amount";
    }
  }
  const acceptsDeposits = ["draft", "open", "frozen", "proposed"].includes(
    status,
  );
  const canDeposit =
    PREDICTION_FUNDING_ENABLED &&
    acceptsDeposits &&
    !!depositAmount &&
    !loading &&
    !walletLoading &&
    !pending &&
    !error &&
    !walletError;

  async function deposit() {
    if (!canDeposit || !depositAmount || !position) return;
    setPending(true);
    setActionError(null);
    setSignature(null);
    try {
      // Wallet balance is aggregated for display. Each transfer uses one
      // owned source account; fragmentation is reported rather than guessed.
      const source = await findOwnedTokenAccount(
        connection,
        wallet.publicKey,
        collateralMint,
        depositAmount,
      );
      const ix = await program.methods
        .depositPredictionCollateral(depositAmount)
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
      const confirmed = await (
        program.provider as AnchorProvider
      ).sendAndConfirm(new Transaction().add(ix));
      setSignature(confirmed);
      setResultKind("deposit");
      setAmount("");
      setRefresh((value) => value + 1);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Collateral deposit failed",
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
              void deposit();
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
              Deposit amount ({collateralSymbol})
              <input
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                disabled={pending}
                placeholder="10"
                aria-describedby="prediction-deposit-issue"
              />
            </label>
            <small id="prediction-deposit-issue">
              {depositIssue ??
                "Depositing credits available collateral; it does not create YES/NO positions."}
            </small>
            {!PREDICTION_FUNDING_ENABLED && (
              <p>Public funding is disabled until withdrawals are ready.</p>
            )}
            {!acceptsDeposits && (
              <p>This market no longer accepts new collateral deposits.</p>
            )}
            <button
              className="primary-button"
              type="submit"
              disabled={!canDeposit}
            >
              {pending ? "Confirming…" : "Deposit collateral"}
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
      <p>Withdrawals and outcome trading will be added in later milestones.</p>
    </section>
  );
}
