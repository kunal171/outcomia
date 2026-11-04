"use client";

import { useEffect, useMemo, useState } from "react";
import { AnchorProvider, type BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  derivePredictionPositionPda,
  PREDICTION_DRAFTS_ENABLED,
  type PredictionPositionAccount,
} from "../lib/prediction";
import {
  accountExplorerUrl,
  formatAtomicAmount,
  getTidebookAccounts,
  getTidebookProgram,
  transactionExplorerUrl,
} from "../lib/tidebook";

interface PositionProps {
  market: PublicKey;
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
    setError(null);
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
      // Read authoritative account data after confirmation rather than
      // inventing a client-side ledger with assumed balances.
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(
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
      aria-busy={loading || pending}
    >
      <div className="market-list-heading">
        <h2>Your position</h2>
        <button
          className="text-button"
          type="button"
          disabled={loading || pending}
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
          Position initialized.{" "}
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
        Deposits, withdrawals and outcome trading will be added in later
        milestones.
      </p>
    </section>
  );
}
