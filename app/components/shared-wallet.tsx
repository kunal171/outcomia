"use client";
/** Shared funds are reusable across markets. Never count contract backing as spendable cash. */
import { useEffect, useState, useMemo } from "react";
import { AnchorProvider, BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  assetCustody,
  assetBalancePda,
  sharedAccounts,
  SHARED_BALANCES_ENABLED,
  type AssetBalance,
} from "../lib/shared";
import {
  getTidebookProgram,
  accountExplorerUrl,
  getTidebookReadProgram,
  parseTokenAmount,
  TOKEN_PROGRAM_ID,
  transactionExplorerUrl,
} from "../lib/tidebook";
import { readableAmount } from "../lib/market-display";

export function SharedAssetFunds(props: {
  mint: PublicKey;
  decimals: number;
  symbol: string;
  onChanged?: () => void;
}) {
  const wallet = useAnchorWallet(),
    { connection } = useConnection();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!SHARED_BALANCES_ENABLED || !mounted || !wallet) return null;
  return (
    <Funds
      key={`${connection.rpcEndpoint}:${wallet.publicKey}:${props.mint}`}
      {...props}
    />
  );
}
function Funds({
  mint,
  decimals,
  symbol,
  onChanged,
}: {
  mint: PublicKey;
  decimals: number;
  symbol: string;
  onChanged?: () => void;
}) {
  const wallet = useAnchorWallet()!,
    { connection } = useConnection();
  const [balance, setBalance] = useState<AssetBalance | null>(null),
    [amount, setAmount] = useState(""),
    [pending, setPending] = useState(false),
    [loaded, setLoaded] = useState(false),
    [issue, setIssue] = useState<string | null>(null),
    [signature, setSignature] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  const program = useMemo(
    () => getTidebookReadProgram(connection),
    [connection],
  );
  useEffect(() => {
    let dead = false;
    setLoaded(false);
    void sharedAccounts(program)
      .assetBalance.fetchNullable(assetBalancePda(wallet.publicKey, mint))
      .then((b) => {
        if (!dead) {
          setBalance(b);
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
  }, [program, wallet.publicKey, mint, revision]);
  async function act(withdraw: boolean, initializeOnly = false) {
    setPending(true);
    setIssue(null);
    setSignature(null);
    try {
      const p = getTidebookProgram(connection, wallet),
        tx = new Transaction(),
        custody = assetCustody(wallet.publicKey, mint);
      if (!balance)
        tx.add(
          await p.methods
            .initializeAssetBalance()
            .accountsPartial({
              ...custody,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
        );
      if (initializeOnly) {
        setSignature(await (p.provider as AnchorProvider).sendAndConfirm(tx));
        setRevision((v) => v + 1);
        onChanged?.();
        return;
      }
      const atoms = parseTokenAmount(amount, decimals, "Amount");
      if (atoms.lten(0)) throw new Error("Enter a positive amount");
      if (withdraw && (!balance || atoms.gt(balance.free)))
        throw new Error("Amount exceeds shared available balance");
      const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
      let source = ata;
      if (!withdraw) {
        const owned = await connection.getParsedTokenAccountsByOwner(
          wallet.publicKey,
          { mint },
          "confirmed",
        );
        const funded = owned.value.find(
          (r) =>
            r.account.data.parsed?.info?.state !== "frozen" &&
            new BN(r.account.data.parsed?.info?.tokenAmount?.amount ?? "0").gte(
              atoms,
            ),
        );
        if (!funded)
          throw new Error(
            "No single spendable token account has this amount. Use a smaller deposit or consolidate your wallet accounts.",
          );
        source = funded.pubkey;
      }
      // Idempotent creation supports a withdrawal to a wallet that no longer has an ATA.
      if (withdraw)
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            ata,
            wallet.publicKey,
            mint,
          ),
        );
      tx.add(
        await (
          withdraw
            ? p.methods.withdrawAsset(atoms)
            : p.methods.depositAsset(atoms)
        )
          .accountsPartial({
            ...custody,
            walletToken: withdraw ? ata : source,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      );
      setSignature(await (p.provider as AnchorProvider).sendAndConfirm(tx));
      setAmount("");
      setRevision((v) => v + 1);
      onChanged?.();
    } catch (e) {
      setIssue(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  let parsed: BN | null = null;
  try {
    parsed = parseTokenAmount(amount, decimals, "Amount");
  } catch {
    /* Invalid input keeps actions disabled. */
  }
  const positive = parsed !== null && parsed.gtn(0);
  return (
    <section className="admin-card shared-funds">
      <div className="section-heading">
        <h3>{symbol} · shared wallet</h3>
        <button
          type="button"
          disabled={pending}
          onClick={() => setRevision((v) => v + 1)}
        >
          Refresh
        </button>
      </div>
      <a
        className="market-explorer-link"
        href={accountExplorerUrl(mint)}
        target="_blank"
        rel="noreferrer"
      >
        {mint.toBase58().slice(0, 6)}…{mint.toBase58().slice(-6)} ↗
      </a>
      <p>
        Available:{" "}
        <strong>
          {loaded ? readableAmount(balance?.free ?? new BN(0), decimals) : "—"}
        </strong>{" "}
        · In orders:{" "}
        {loaded ? readableAmount(balance?.locked ?? new BN(0), decimals) : "—"}
      </p>
      <p className="muted">
        One deposit works across all shared-wallet markets using this mint.
      </p>
      {loaded && !balance && (
        <button
          type="button"
          disabled={pending}
          onClick={() => void act(false, true)}
        >
          Initialize {symbol} balance once
        </button>
      )}
      <label>
        Amount ({symbol})
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          disabled={pending}
        />
      </label>
      <div className="shared-actions">
        <button
          type="button"
          disabled={pending || !loaded || !positive}
          onClick={() => void act(false)}
        >
          {pending ? "Confirm in wallet…" : "Deposit"}
        </button>
        <button
          type="button"
          disabled={
            pending ||
            !loaded ||
            !positive ||
            !balance ||
            parsed!.gt(balance.free)
          }
          onClick={() => void act(true)}
        >
          Withdraw available
        </button>
      </div>
      {issue && <p role="alert">{issue}</p>}
      {signature && (
        <a
          href={transactionExplorerUrl(signature)}
          target="_blank"
          rel="noreferrer"
        >
          View transaction ↗
        </a>
      )}
    </section>
  );
}
