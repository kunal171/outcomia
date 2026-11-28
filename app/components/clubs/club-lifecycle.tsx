"use client";
/** Owner controls for a club's lifetime: switching between private and public,
 * and closing the club with its deposit refunded (club rules milestone 2b).
 * The program enforces every rule; this card explains, prefills and bundles. */
import { useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { useI18n } from "../preferences-provider";
import type { ClubSnapshot, ClubRulesConfigAccount } from "../../lib/clubs";
import {
  depositAsset,
  depositClubSolInstruction,
  depositClubUsdcInstruction,
  depositShortfall,
  depositsConfigured,
  freshSolUsdPrice,
} from "../../lib/club-deposits";
import {
  closeBlockers,
  closeClubInstruction,
  setClubKindInstruction,
} from "../../lib/club-lifecycle";
import type { useClubTransaction } from "./club-transaction";

type Tx = ReturnType<typeof useClubTransaction>;

export function ClubLifecycle({
  club,
  snapshot,
  rules,
  tx,
}: {
  club: PublicKey;
  snapshot: ClubSnapshot;
  rules: ClubRulesConfigAccount | null;
  tx: Tx;
}) {
  const { t } = useI18n();
  const { connection } = useConnection();
  const [confirming, setConfirming] = useState(false);
  const account = snapshot.club;
  const deposit = depositsConfigured(rules) ? rules : null;
  const kind = account.kind?.public ? "public" : "private";
  const asset = depositAsset(account);
  const blockers = closeBlockers(account);
  const tooLarge =
    kind === "public" && !!rules && account.memberCount > rules.privateMemberCap;
  const unsettled = snapshot.markets.filter((m) => !m.settled).length;

  /** USDC refunds land in the owner's associated token account. */
  function refundAccount(signer: PublicKey, before: TransactionInstruction[]) {
    if (!deposit || asset !== "usdc") return null;
    const ownerToken = getAssociatedTokenAddressSync(deposit.depositMint, signer);
    before.push(
      createAssociatedTokenAccountIdempotentInstruction(
        signer,
        ownerToken,
        signer,
        deposit.depositMint,
      ),
    );
    return { ownerToken };
  }

  async function switchKind() {
    if (!deposit) return;
    const target = kind === "public" ? "private" : "public";
    await tx.run(async (p, signer) => {
      const instructions: TransactionInstruction[] = [];
      const read = asset === "sol" ? await freshSolUsdPrice(connection, deposit) : null;
      const price = read?.address ?? null;
      if (target === "public") {
        // Top up to the public payment minimum in the same transaction.
        const current = BigInt(account.depositAmount?.toString() ?? "0");
        if (asset === "usdc") {
          const missing = depositShortfall(deposit, "public", "usdc", current);
          if (missing > BigInt(0))
            instructions.push(
              await depositClubUsdcInstruction(
                p,
                signer,
                club,
                deposit.depositMint,
                getAssociatedTokenAddressSync(deposit.depositMint, signer),
                missing,
              ),
            );
        } else if (asset === "sol" && read) {
          const missing = depositShortfall(deposit, "public", "sol", current, read.price);
          if (missing > BigInt(0))
            instructions.push(
              await depositClubSolInstruction(
                p,
                signer,
                club,
                read.address,
                (missing * BigInt(101) + BigInt(99)) / BigInt(100),
              ),
            );
        }
        instructions.push(
          await setClubKindInstruction(p, signer, club, target, price, null),
        );
        return instructions;
      }
      const usdc = refundAccount(signer, instructions);
      instructions.push(
        await setClubKindInstruction(p, signer, club, target, price, usdc),
      );
      return instructions;
    });
  }

  async function close() {
    setConfirming(false);
    await tx.run(async (p, signer) => {
      const instructions: TransactionInstruction[] = [];
      const usdc = refundAccount(signer, instructions);
      instructions.push(await closeClubInstruction(p, signer, club, usdc));
      return instructions;
    });
  }

  if (account.closed) return null;
  return (
    <section className="ui-card" aria-label={t("Club type and closing")}>
      <div className="club-card-head">
        <h2 className="ui-h3">{t("Club type and closing")}</h2>
      </div>

      <h3 className="club-subhead">
        {kind === "public" ? t("Make the club private") : t("Make the club public")}
      </h3>
      <p className="club-help">
        {kind === "public"
          ? t(
              "The listing is removed and the deposit above the private minimum is refunded to you. Private clubs allow up to {value0} members.",
              { value0: (rules?.privateMemberCap ?? 1000).toLocaleString() },
            )
          : t(
              "Public clubs can be listed and allow up to {value0} members. The deposit is topped up to the public minimum in the same transaction.",
              { value0: (rules?.publicMemberCap ?? 100000).toLocaleString() },
            )}
      </p>
      {kind === "private" && asset === "none" && (
        <p className="ui-notice" role="status">
          {t("Pay the security deposit before making the club public.")}
        </p>
      )}
      {tooLarge && (
        <p className="ui-notice" role="status">
          {t("The club has more members than a private club allows.")}
        </p>
      )}
      <div className="ui-actions">
        <button
          type="button"
          className="ui-btn"
          disabled={
            tx.pending ||
            !deposit ||
            tooLarge ||
            (kind === "private" && asset === "none")
          }
          onClick={() => void switchKind()}
        >
          {kind === "public" ? t("Make private") : t("Make public")}
        </button>
      </div>

      <h3 className="club-subhead">{t("Close the club")}</h3>
      <p className="club-help">
        {t(
          "Closing refunds the whole deposit to you, removes the listing and frees your club slot. Members keep their positions and can still leave. A closed club cannot be reopened.",
        )}
      </p>
      {blockers.map((issue) => (
        <p className="ui-notice" role="status" key={issue}>
          {t(issue)}
        </p>
      ))}
      {unsettled > 0 && account.liveMarketsReady !== false && (
        <p className="club-help">
          {t("{value0} club markets are not settled yet.", {
            value0: String(unsettled),
          })}
        </p>
      )}
      <div className="ui-actions">
        {confirming ? (
          <>
            <button
              type="button"
              className="ui-btn ui-btn-no"
              disabled={tx.pending}
              onClick={() => void close()}
            >
              {t("Yes, close the club")}
            </button>
            <button
              type="button"
              className="ui-btn"
              onClick={() => setConfirming(false)}
            >
              {t("Cancel")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ui-btn"
            disabled={tx.pending || blockers.length > 0}
            onClick={() => setConfirming(true)}
          >
            {t("Close club")}
          </button>
        )}
      </div>
    </section>
  );
}
