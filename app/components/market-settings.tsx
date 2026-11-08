"use client";
import { useI18n } from "./preferences-provider";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  decodeMarketKind,
  deriveAdminRecordPda,
  deriveMarketMetadataPda,
  getTidebookAccounts,
  getTidebookProgram,
  getTidebookReadProgram,
  transactionExplorerUrl,
  type MarketAccount,
  type MarketMetadataAccount,
} from "../lib/tidebook";
import { AppHeader } from "./app-header";
import { useProtocolRole } from "./protocol-role-provider";

function shortAddress(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function getErrorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Unable to update market";
}

export function MarketSettings({ address }: { address: string }) {
  const { t } = useI18n();

  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { role, loading: roleLoading, error: roleError } = useProtocolRole();
  const [market, setMarket] = useState<MarketAccount | null>(null);
  const [metadata, setMetadata] = useState<MarketMetadataAccount | null>(null);
  const [baseSymbol, setBaseSymbol] = useState("");
  const [quoteSymbol, setQuoteSymbol] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<"spot" | "other">("spot");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  const marketAddress = useMemo(() => {
    try {
      return new PublicKey(address);
    } catch {
      return null;
    }
  }, [address]);

  const readProgram = useMemo(
    () => getTidebookReadProgram(connection),
    [connection],
  );
  const signedProgram = useMemo(
    () => (wallet ? getTidebookProgram(connection, wallet) : null),
    [connection, wallet],
  );

  const loadSettings = useCallback(async () => {
    if (!marketAddress) {
      setError("Invalid market address");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const accounts = getTidebookAccounts(readProgram);
      const [marketAccount, metadataAccount] = await Promise.all([
        accounts.market.fetchNullable(marketAddress),
        accounts.marketMetadata.fetchNullable(
          deriveMarketMetadataPda(marketAddress),
        ),
      ]);

      setMarket(marketAccount);
      setMetadata(metadataAccount);
      if (!marketAccount) {
        setError("Market account was not found on devnet");
        return;
      }

      if (metadataAccount) {
        setBaseSymbol(metadataAccount.baseSymbol);
        setQuoteSymbol(metadataAccount.quoteSymbol);
        setDisplayName(metadataAccount.displayName);
        const currentKind = decodeMarketKind(metadataAccount.kind);
        if (currentKind !== "prediction") setKind(currentKind);
      }
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [marketAddress, readProgram]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const saveMetadata = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!signedProgram || !wallet || !marketAddress || !market) return;

    setPending(true);
    setError(null);
    setSignature(null);
    try {
      const normalizedBase = baseSymbol.trim();
      const normalizedQuote = quoteSymbol.trim();
      const normalizedName = displayName.trim();

      if (!/^[A-Za-z0-9._-]{1,16}$/.test(normalizedBase)) {
        throw new Error(
          "Base symbol must contain 1-16 letters, digits, '.', '-' or '_'",
        );
      }
      if (!/^[A-Za-z0-9._-]{1,16}$/.test(normalizedQuote)) {
        throw new Error(
          "Quote symbol must contain 1-16 letters, digits, '.', '-' or '_'",
        );
      }
      if (!normalizedName || normalizedName.length > 64) {
        throw new Error("Display name must contain 1-64 characters");
      }

      const commonAccounts = {
        authority: wallet.publicKey,
        adminRecord: deriveAdminRecordPda(wallet.publicKey),
        market: marketAddress,
        marketMetadata: deriveMarketMetadataPda(marketAddress),
      };
      const transactionSignature = metadata
        ? await signedProgram.methods
            .updateMarketMetadata(
              normalizedBase,
              normalizedQuote,
              normalizedName,
            )
            .accounts(commonAccounts)
            .rpc()
        : await signedProgram.methods
            .initializeMarketMetadata(
              normalizedBase,
              normalizedQuote,
              normalizedName,
              kind === "other" ? { other: {} } : { spot: {} },
            )
            .accounts({
              ...commonAccounts,
              systemProgram: SystemProgram.programId,
            })
            .rpc();

      setSignature(transactionSignature);
      await loadSettings();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const isAdmin = role === "super-admin" || role === "admin";
  const title =
    metadata?.displayName ??
    (marketAddress ? shortAddress(marketAddress.toBase58()) : "Market");

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell route-shell-narrow">
        <div className="market-detail-back">
          <Link
            href={
              marketAddress
                ? `/markets/${marketAddress.toBase58()}`
                : "/markets"
            }
          >
            {t("← Back to market")}
          </Link>
        </div>

        <div className="route-heading">
          <h1>{t("Manage market")}</h1>
          <p>
            {t("Update the human-readable identity for")}{" "}
            <strong>{title}</strong>
            {t(
              ". The market address, mint pair, and trading state do not change.",
            )}
          </p>
        </div>

        {!wallet && (
          <div className="access-card">
            {t("Connect an administrator wallet to continue.")}
          </div>
        )}
        {wallet && (roleLoading || loading) && (
          <div className="access-card">{t("Loading market permissions…")}</div>
        )}
        {wallet && !roleLoading && !loading && !isAdmin && (
          <div className="access-card access-denied">
            {t("This page requires an active protocol administrator.")}
          </div>
        )}

        {wallet && !roleLoading && !loading && isAdmin && market && (
          <section className="admin-card">
            <div className="admin-list-heading market-settings-summary">
              <div>
                <div className="card-label">{t("Market identity")}</div>
                <h2>
                  {metadata ? t("Update labels") : t("Initialize metadata")}
                </h2>
              </div>
              {metadata && (
                <span className="role-badge">
                  {decodeMarketKind(metadata.kind)}
                </span>
              )}
            </div>

            <p className="market-settings-address">
              {t("Market")} <code>{marketAddress?.toBase58()}</code>
            </p>

            <form className="market-create-form" onSubmit={saveMetadata}>
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
                  placeholder={t("Tidebook SOL / USDC")}
                  maxLength={64}
                  autoComplete="off"
                  required
                />
              </label>
              <label>
                {t("Market type")}
                <select
                  value={kind}
                  disabled={metadata !== null}
                  onChange={(event) =>
                    setKind(event.target.value as "spot" | "other")
                  }
                >
                  <option value="spot">{t("Spot")}</option>
                  <option value="other">{t("Other (experimental)")}</option>
                  <option value="prediction" disabled>
                    {t("Prediction (coming later)")}
                  </option>
                </select>
                {metadata && (
                  <small>
                    {t("Market type is immutable after initialization.")}
                  </small>
                )}
              </label>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  pending ||
                  !baseSymbol.trim() ||
                  !quoteSymbol.trim() ||
                  !displayName.trim()
                }
              >
                {pending
                  ? t("Saving metadata…")
                  : metadata
                    ? t("Update market")
                    : t("Initialize metadata")}
              </button>
            </form>
          </section>
        )}

        {(roleError || error) && (
          <div className="transaction-message transaction-error">
            {roleError || error}
          </div>
        )}
        {signature && (
          <div className="transaction-message transaction-success">
            {t("Market metadata saved.")}{" "}
            <a
              href={transactionExplorerUrl(signature)}
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
