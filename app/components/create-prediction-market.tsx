"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { AnchorProvider, BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { getMint } from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { AppHeader } from "./app-header";
import { useProtocolRole } from "./protocol-role-provider";
import {
  derivePredictionMarketPda,
  derivePredictionBookPda,
  parsePredictionRules,
  PREDICTION_DRAFTS_ENABLED,
  validatePredictionCreatorResolver,
} from "../lib/prediction";
import {
  deriveAdminRecordPda,
  deriveMarketFeesPda,
  deriveMarketMetadataPda,
  deriveVaultAuthorityPda,
  deriveVaultPda,
  getTidebookProgram,
  parseTokenAmount,
  TOKEN_PROGRAM_ID,
  transactionExplorerUrl,
} from "../lib/tidebook";

export function CreatePredictionMarket() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { role, loading, error: roleError } = useProtocolRole();
  const isAdmin = !loading && (role === "admin" || role === "super-admin");
  const program = useMemo(
    () => (wallet ? getTidebookProgram(connection, wallet) : null),
    [connection, wallet],
  );
  const [name, setName] = useState("");
  const [mint, setMint] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [tick, setTick] = useState("0.01");
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    market: string;
    signature: string;
  } | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !PREDICTION_DRAFTS_ENABLED ||
      !isAdmin ||
      !program ||
      !wallet ||
      pending
    )
      return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      if (!file)
        throw new Error("Select the exact rules JSON file uploaded to Arweave");
      if (file.size > 128 * 1024) throw new Error("Rules file exceeds 128 KiB");
      if (!/^[\x20-\x7e]{1,64}$/.test(name) || name.trim() !== name)
        throw new Error(
          "Use a short name of 1–64 printable ASCII characters without outer spaces",
        );
      if (!/^[A-Za-z0-9._-]{1,16}$/.test(symbol))
        throw new Error(
          "Collateral symbol must contain 1–16 letters, digits, '.', '-' or '_'",
        );
      if (
        uri.length > 200 ||
        !/^(?:ar|https):\/\/[^\s/?#][^\s]*$/.test(uri) ||
        !/^[\x21-\x7e]+$/.test(uri)
      )
        throw new Error(
          "Enter an ar:// or HTTPS rules reference of at most 200 ASCII bytes",
        );
      const rules = await parsePredictionRules(await file.arrayBuffer());
      validatePredictionCreatorResolver(rules.resolver, wallet.publicKey);
      if (rules.closeTs.lte(new BN(String(Math.floor(Date.now() / 1000)))))
        throw new Error("Trading close time must be in the future");
      const collateralMint = new PublicKey(mint.trim());
      const mintAccount = await getMint(
        connection,
        collateralMint,
        "confirmed",
        TOKEN_PROGRAM_ID,
      );
      const payout = parseTokenAmount(
        "1",
        mintAccount.decimals,
        "Contract payout",
      );
      const priceTick = parseTokenAmount(
        tick,
        mintAccount.decimals,
        "Price tick",
      );
      if (
        payout.isOdd() ||
        priceTick.gte(payout) ||
        !payout.mod(priceTick).isZero()
      )
        throw new Error(
          "Use a collateral mint with decimals and a tick below 1 that divides 1 exactly",
        );
      // New random IDs permit multiple independent questions for one mint.
      const marketId = crypto.getRandomValues(new Uint8Array(32));
      const market = derivePredictionMarketPda(marketId);
      const instruction = await program.methods
        .initializePredictionMarket(
          Array.from(marketId),
          {
            resolver: rules.resolver,
            fallback: rules.fallback,
            closeTs: rules.closeTs,
            earliestResolutionTs: rules.earliestResolutionTs,
            resolutionDelaySeconds: rules.resolutionDelaySeconds,
            payoutPerContract: payout,
            priceTick,
            rulesUri: uri,
            questionHash: rules.questionHash,
            rulesHash: rules.rulesHash,
          },
          name,
          symbol,
        )
        .accounts({
          authority: wallet.publicKey,
          adminRecord: deriveAdminRecordPda(wallet.publicKey),
          market,
          collateralMint,
          vaultAuthority: deriveVaultAuthorityPda(market),
          collateralVault: deriveVaultPda(market, collateralMint),
          marketMetadata: deriveMarketMetadataPda(market),
          marketFees: deriveMarketFeesPda(market),
          orderBook: derivePredictionBookPda(market),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const signature = await (
        program.provider as AnchorProvider
      ).sendAndConfirm(new Transaction().add(instruction));
      setResult({ market: market.toBase58(), signature });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Draft creation failed",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell route-shell-narrow">
        <Link className="text-button" href="/predictions">
          ← Prediction markets
        </Link>
        <div className="route-heading">
          <div className="eyebrow">Prediction market setup</div>
          <h1>Create a draft</h1>
          <p>
            One collateral token backs each YES/NO pair. Create a draft, then
            open it as its active-admin creator. Outcome trading and payouts are
            still being built.
          </p>
        </div>
        {!PREDICTION_DRAFTS_ENABLED && (
          <div className="access-card">
            Draft creation is awaiting the prediction-program deployment.
          </div>
        )}
        {!wallet ? (
          <div className="access-card">Connect your administrator wallet.</div>
        ) : loading ? (
          <div className="access-card">Checking role…</div>
        ) : (
          !isAdmin && (
            <div className="access-card">
              An active administrator role is required.
            </div>
          )
        )}
        {roleError && (
          <div className="access-card access-denied" role="alert">
            {roleError}
          </div>
        )}
        {isAdmin && (
          <form
            className="admin-card market-create-form"
            onSubmit={(event) => void create(event)}
          >
            <label>
              Short display name
              <input
                required
                maxLength={64}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Collateral mint
              <input
                required
                value={mint}
                onChange={(e) => setMint(e.target.value)}
                placeholder="SPL token mint address"
              />
            </label>
            <label>
              Collateral symbol
              <input
                required
                maxLength={16}
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="tUSDC"
              />
            </label>
            <label>
              Price increment per contract
              <input
                required
                value={tick}
                onChange={(e) => setTick(e.target.value)}
                inputMode="decimal"
              />
            </label>
            <label>
              Arweave rules reference
              <input
                required
                maxLength={200}
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                placeholder="ar://transaction-id"
              />
            </label>
            <label>
              Exact uploaded rules JSON
              <input
                required
                type="file"
                accept="application/json,.json"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <p>
              The file supplies the full question, resolver keys, closing time
              and optional fallback. Its primaryResolver must be your connected
              creator wallet, which will decide the outcome. Its exact bytes are
              hashed locally. This form does not upload the file or verify the
              remote copy.
            </p>
            <button
              className="primary-button"
              type="submit"
              disabled={!PREDICTION_DRAFTS_ENABLED || pending || !!roleError}
            >
              {pending ? "Creating draft…" : "Create draft"}
            </button>
          </form>
        )}
        {error && (
          <div className="access-card access-denied" role="alert">
            {error}
          </div>
        )}
        {result && (
          <div className="access-card transaction-success">
            <p>
              Draft confirmed.{" "}
              <Link href={`/predictions/${result.market}`}>
                Inspect draft →
              </Link>
            </p>
            <a
              href={transactionExplorerUrl(result.signature)}
              target="_blank"
              rel="noreferrer"
            >
              View transaction ↗
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
