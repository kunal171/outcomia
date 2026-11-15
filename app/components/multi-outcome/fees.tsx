"use client";
import { useState } from "react";
import { Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  deriveProtocolConfigPda,
  parseTokenAmount,
  TOKEN_PROGRAM_ID,
} from "../../lib/outcomia";
import { readableAmount } from "../../lib/market-display";
import { assetAuthorityPda, assetVaultPda } from "../../lib/shared";
import { multiBookPda } from "../../lib/multi-outcome";
import { useProtocolRole } from "../protocol-role-provider";
import type { MultiSession } from "./use-market";
/** Fees are book-owned claims, never presented as a user's spendable cash. */
export function MultiFees({ session: s }: { session: MultiSession }) {
  const { role } = useProtocolRole(),
    [amount, setAmount] = useState("");
  const d = s.data;
  if (role !== "super-admin" || !d?.book) return null;
  const fees = d.book.book.accruedCollateralFees;
  return (
    <details>
      <summary>Protocol fees</summary>
      <p>
        Earned fees: {readableAmount(fees, d.decimals)}{" "}
        {d.metadata?.quoteSymbol ?? "collateral"}. Withdrawal goes to your
        wallet's associated token account.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void s.send(async () => {
            if (!s.signed || !s.wallet)
              throw new Error("Connect the super-admin wallet.");
            const atoms = parseTokenAmount(
              amount,
              d.decimals,
              "Fee withdrawal",
            );
            if (atoms.lten(0) || atoms.gt(fees))
              throw new Error(
                "Withdraw a positive amount no greater than this book's earned fees.",
              );
            const owner = s.wallet.publicKey,
              mint = d.market.collateralMint,
              destination = getAssociatedTokenAddressSync(mint, owner);
            return new Transaction().add(
              createAssociatedTokenAccountIdempotentInstruction(
                owner,
                destination,
                owner,
                mint,
              ),
              await s.signed.methods
                .withdrawMultiOutcomeFees(atoms)
                .accountsStrict({
                  superAdmin: owner,
                  protocolConfig: deriveProtocolConfigPda(),
                  market: d.key,
                  book: multiBookPda(d.key),
                  mint,
                  destination,
                  vaultAuthority: assetAuthorityPda(mint),
                  assetVault: assetVaultPda(mint),
                  tokenProgram: TOKEN_PROGRAM_ID,
                })
                .instruction(),
            );
          });
        }}
      >
        <label>
          Fee withdrawal ({d.metadata?.quoteSymbol ?? "collateral"})
          <input
            required
            inputMode="decimal"
            disabled={s.busy}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <button disabled={s.busy || s.loading || fees.isZero()}>
          Withdraw earned fees
        </button>
      </form>
    </details>
  );
}
