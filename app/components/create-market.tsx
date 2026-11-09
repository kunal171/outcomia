"use client";
import { useI18n } from "./preferences-provider";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AnchorProvider, BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  deriveAdminRecordPda,
  deriveMarketFeesPda,
  deriveMarketMetadataPda,
  deriveMarketPda,
  deriveVaultAuthorityPda,
  deriveVaultPda,
  getOutcomiaProgram,
  TOKEN_PROGRAM_ID,
  transactionExplorerUrl,
} from "../lib/outcomia";
import { AppHeader } from "./app-header";
import { useProtocolRole } from "./protocol-role-provider";

function getErrorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Market creation failed";
}

function parsePositiveU64(value: string, label: string) {
  const normalized = value.trim();

  if (!/^[0-9]+$/.test(normalized)) {
    throw new Error(`${label} must be a positive whole number`);
  }

  const number = new BN(normalized, 10);
  if (number.isZero()) {
    throw new Error(`${label} must be greater than zero`);
  }
  if (number.bitLength() > 64) {
    throw new Error(`${label} exceeds the u64 limit`);
  }

  return number;
}

export function CreateMarket() {
  const { t } = useI18n();

  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { role, loading: roleLoading, error: roleError } = useProtocolRole();
  const [baseMint, setBaseMint] = useState("");
  const [quoteMint, setQuoteMint] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    signature: string;
    market: PublicKey;
  } | null>(null);
  const [priceTickSize, setPriceTickSize] = useState("");
  const [quantityLotSize, setQuantityLotSize] = useState("");
  const [baseSymbol, setBaseSymbol] = useState("");
  const [quoteSymbol, setQuoteSymbol] = useState("");
  const [displayName, setDisplayName] = useState("");

  const program = useMemo(
    () => (wallet ? getOutcomiaProgram(connection, wallet) : null),
    [connection, wallet],
  );

  const createMarket = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!program || !wallet) return;

    setPending(true);
    setError(null);
    setResult(null);

    try {
      const base = new PublicKey(baseMint.trim());
      const quote = new PublicKey(quoteMint.trim());

      if (base.equals(quote)) {
        throw new Error("Base and quote mints must be different");
      }
      const tickSize = parsePositiveU64(priceTickSize, "Price tick size");
      const lotSize = parsePositiveU64(quantityLotSize, "Quantity lot size");
      const normalizedBaseSymbol = baseSymbol.trim();
      const normalizedQuoteSymbol = quoteSymbol.trim();
      const normalizedDisplayName = displayName.trim();

      if (!/^[A-Za-z0-9._-]{1,16}$/.test(normalizedBaseSymbol)) {
        throw new Error(
          "Base symbol must contain 1-16 letters, digits, '.', '-' or '_'",
        );
      }
      if (!/^[A-Za-z0-9._-]{1,16}$/.test(normalizedQuoteSymbol)) {
        throw new Error(
          "Quote symbol must contain 1-16 letters, digits, '.', '-' or '_'",
        );
      }
      if (!normalizedDisplayName || normalizedDisplayName.length > 64) {
        throw new Error("Display name must contain 1-64 characters");
      }

      // Derive the same canonical account graph enforced by Anchor. The market,
      // fee accumulator, and both vaults are created atomically.
      const market = deriveMarketPda(base, quote);
      const marketFees = deriveMarketFeesPda(market);
      const vaultAuthority = deriveVaultAuthorityPda(market);
      const baseVault = deriveVaultPda(market, base);
      const quoteVault = deriveVaultPda(market, quote);
      const marketMetadata = deriveMarketMetadataPda(market);
      const marketInstruction = await program.methods
        .initializeMarket(tickSize, lotSize)
        .accounts({
          authority: wallet.publicKey,
          adminRecord: deriveAdminRecordPda(wallet.publicKey),
          market,
          marketFees,
          baseMint: base,
          quoteMint: quote,
          vaultAuthority,
          baseVault,
          quoteVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const metadataInstruction = await program.methods
        .initializeMarketMetadata(
          normalizedBaseSymbol,
          normalizedQuoteSymbol,
          normalizedDisplayName,
          { spot: {} },
        )
        .accounts({
          authority: wallet.publicKey,
          adminRecord: deriveAdminRecordPda(wallet.publicKey),
          market,
          marketMetadata,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const provider = program.provider as AnchorProvider;
      const signature = await provider.sendAndConfirm(
        new Transaction().add(marketInstruction, metadataInstruction),
      );

      setResult({ signature, market });
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const isAdmin = role === "super-admin" || role === "admin";

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell route-shell-narrow">
        <Link className="market-type-back" href="/markets/new">
          {t("← Change market type")}
        </Link>
        <div className="route-heading">
          <h1>{t("Create a spot market")}</h1>
        </div>

        {!wallet && (
          <div className="access-card">
            {t("Connect your wallet to continue.")}
          </div>
        )}
        {wallet && roleLoading && (
          <div className="access-card">{t("Checking administrator role…")}</div>
        )}
        {wallet && !roleLoading && !roleError && !isAdmin && (
          <div className="access-card access-denied">
            {t("This route requires an active administrator wallet.")}
          </div>
        )}

        {wallet && !roleLoading && isAdmin && (
          <form
            className="admin-card market-create-form"
            onSubmit={(event) => void createMarket(event)}
          >
            <label>
              {t("Base mint")}
              <input
                value={baseMint}
                onChange={(event) => setBaseMint(event.target.value)}
                placeholder={t("SPL Token mint address")}
                autoComplete="off"
              />
            </label>
            <label>
              {t("Quote mint")}
              <input
                value={quoteMint}
                onChange={(event) => setQuoteMint(event.target.value)}
                placeholder={t("SPL Token mint address")}
                autoComplete="off"
              />
            </label>
            <label>
              {t("Base symbol")}
              <input
                value={baseSymbol}
                onChange={(event) => setBaseSymbol(event.target.value)}
                placeholder="tSOL"
                maxLength={16}
                autoComplete="off"
                required
              />
            </label>
            <label>
              {t("Quote symbol")}
              <input
                value={quoteSymbol}
                onChange={(event) => setQuoteSymbol(event.target.value)}
                placeholder="tUSDC"
                maxLength={16}
                autoComplete="off"
                required
              />
            </label>
            <label>
              {t("Display name")}
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t("Outcomia SOL / USDC")}
                maxLength={64}
                autoComplete="off"
                required
              />
            </label>
            <label>
              {t("Price tick size")}
              <input
                inputMode="numeric"
                value={priceTickSize}
                onChange={(event) => setPriceTickSize(event.target.value)}
                placeholder="10000"
                autoComplete="off"
                required
              />
            </label>

            <label>
              {t("Quantity lot size")}
              <input
                inputMode="numeric"
                value={quantityLotSize}
                onChange={(event) => setQuantityLotSize(event.target.value)}
                placeholder="100000"
                autoComplete="off"
                required
              />
            </label>
            <button
              className="primary-button"
              type="submit"
              disabled={
                !baseMint.trim() ||
                !quoteMint.trim() ||
                !priceTickSize.trim() ||
                !quantityLotSize.trim() ||
                !baseSymbol.trim() ||
                !quoteSymbol.trim() ||
                !displayName.trim() ||
                pending
              }
            >
              {pending ? t("Creating market…") : t("Create spot market")}
            </button>
          </form>
        )}

        {(roleError || error) && (
          <div className="transaction-message transaction-error">
            {roleError || error}
          </div>
        )}
        {result && (
          <div className="transaction-message transaction-success">
            <strong>{t("Market created:")}</strong> {result.market.toBase58()}{" "}
            <a
              href={transactionExplorerUrl(result.signature)}
              target="_blank"
              rel="noreferrer"
            >
              {t("View transaction ↗")}
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
