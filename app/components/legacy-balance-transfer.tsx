"use client";
import { useI18n } from "./preferences-provider";

/** Owner-signed transfer of free legacy cash; order locks and prediction reserves never move. */
import { useState } from "react";
import { AnchorProvider, type BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  SHARED_BALANCES_ENABLED,
  assetCustody,
  assetAuthorityPda,
  sharedAccounts,
} from "../lib/shared";
import {
  getTidebookProgram,
  deriveVaultAuthorityPda,
  deriveVaultPda,
  deriveTraderBalancePda,
  TOKEN_PROGRAM_ID,
} from "../lib/tidebook";
import { derivePredictionPositionPda } from "../lib/prediction";
export function LegacyBalanceTransfer({
  market,
  mint,
  amount,
  symbol,
  kind,
  onChanged,
}: {
  market: PublicKey;
  mint: PublicKey;
  amount: BN;
  symbol: string;
  kind: "spot" | "prediction";
  onChanged: () => void;
}) {
  const { t } = useI18n();

  const wallet = useAnchorWallet(),
    { connection } = useConnection(),
    [pending, setPending] = useState(false),
    [issue, setIssue] = useState<string | null>(null);
  if (!SHARED_BALANCES_ENABLED || !wallet || amount.isZero()) return null;
  async function move() {
    if (!wallet) return;
    setPending(true);
    setIssue(null);
    try {
      const p = getTidebookProgram(connection, wallet),
        tx = new Transaction(),
        c = assetCustody(wallet.publicKey, mint);
      if (!(await sharedAccounts(p).assetBalance.fetchNullable(c.assetBalance)))
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
      const accounts = {
        owner: wallet.publicKey,
        market,
        mint,
        assetBalance: c.assetBalance,
        marketAuthority: deriveVaultAuthorityPda(market),
        marketVault: deriveVaultPda(market, mint),
        assetAuthority: assetAuthorityPda(mint),
        assetVault: c.assetVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      };
      tx.add(
        await (
          kind === "spot"
            ? p.methods.migrateSpotAsset(amount).accountsPartial({
                ...accounts,
                traderBalance: deriveTraderBalancePda(market, wallet.publicKey),
              })
            : p.methods.migratePredictionAsset(amount).accountsPartial({
                ...accounts,
                position: derivePredictionPositionPda(market, wallet.publicKey),
              })
        ).instruction(),
      );
      await (p.provider as AnchorProvider).sendAndConfirm(tx);
      onChanged();
    } catch (e) {
      setIssue(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <button
        className="market-open-link"
        type="button"
        disabled={pending}
        onClick={() => void move()}
      >
        {pending
          ? t("Confirm transfer…")
          : t("Move free {value0} to shared wallet", { value0: symbol })}
      </button>
      {issue && <p role="alert">{t(issue ?? "")}</p>}
    </div>
  );
}
