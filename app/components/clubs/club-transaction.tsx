"use client";
/** Signing state shared by club pages: one transaction at a time, with its
 * outcome reported in place. Every permission is enforced by the program. */
import { useState, type ReactNode } from "react";
import { AnchorProvider, type Program } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  Transaction,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { useI18n } from "../preferences-provider";
import { getOutcomiaProgram, transactionExplorerUrl } from "../../lib/outcomia";

export function useClubTransaction(onDone?: () => void) {
  const { connection } = useConnection(),
    wallet = useAnchorWallet();
  const [pending, setPending] = useState(false),
    [issue, setIssue] = useState<string | null>(null),
    [signature, setSignature] = useState<string | null>(null);
  async function run(
    build: (p: Program, signer: PublicKey) => Promise<TransactionInstruction[]>,
  ) {
    if (!wallet || pending) return false;
    setPending(true);
    setIssue(null);
    setSignature(null);
    try {
      const p = getOutcomiaProgram(connection, wallet);
      const instructions = await build(p, wallet.publicKey);
      const confirmed = await (p.provider as AnchorProvider).sendAndConfirm(
        new Transaction().add(...instructions),
      );
      setSignature(confirmed);
      onDone?.();
      return true;
    } catch (cause) {
      setIssue(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setPending(false);
    }
  }
  return { wallet, pending, issue, signature, run, setIssue };
}

export function ClubFeedback({
  issue,
  signature,
}: {
  issue: string | null;
  signature: string | null;
}): ReactNode {
  const { t } = useI18n();
  return (
    <>
      {issue && (
        <p className="access-denied" role="alert">
          {t(issue)}
        </p>
      )}
      {signature && (
        <a
          href={transactionExplorerUrl(signature)}
          target="_blank"
          rel="noreferrer"
        >
          {t("View transaction ↗")}
        </a>
      )}
    </>
  );
}

export const shortKey = (key: PublicKey) => {
  const text = key.toBase58();
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
};
