"use client";
import { useState } from "react";
import { Transaction, SystemProgram } from "@solana/web3.js";
import { deriveAdminRecordPda } from "../../lib/outcomia";
import { multiBookPda } from "../../lib/multi-outcome";
import { useProtocolRole } from "../protocol-role-provider";
import { resolutionAvailability } from "../../lib/multi-outcome-lifecycle";
import { useMarketClock } from "./use-clock";
import type { MultiSession } from "./use-market";
import { useI18n } from "../preferences-provider";
export function MultiResolution({ session: s }: { session: MultiSession }) {
  const [result, setResult] = useState("invalid"),
    [uri, setUri] = useState(""),
    [hash, setHash] = useState("");
  const now = useMarketClock(),
    { t } = useI18n();
  const { role } = useProtocolRole(),
    d = s.data;
  if (!d) return null;
  const ready = !!s.wallet && !!s.signed && !s.busy && !s.loading,
    admin = role === "admin" || role === "super-admin";
  const creator = admin && !!s.wallet?.publicKey.equals(d.market.authority);
  const closed = now >= d.market.terms.closeTs.toNumber();
  const availability = resolutionAvailability(
    d.market,
    s.wallet?.publicKey ?? null,
    admin,
    now,
  );
  const proposed = d.market.proposal,
    readyAt = availability.matureAt?.toNumber() ?? null;
  const advance = (action: number) =>
    void s.send(async () => {
      if (!s.signed) throw new Error("Connect a wallet.");
      return new Transaction().add(
        await s.signed.methods
          .advanceMultiOutcome(action)
          .accountsStrict({ market: d.key })
          .instruction(),
      );
    });
  const manage = (action: "open" | "close" | "book") =>
    void s.send(async () => {
      if (!s.signed || !s.wallet) throw new Error("Connect a wallet.");
      const accounts = {
        authority: s.wallet.publicKey,
        market: d.key,
        adminRecord: deriveAdminRecordPda(s.wallet.publicKey),
      };
      const ix =
        action === "book"
          ? await s.signed.methods
              .initializeMultiOutcomeBook()
              .accountsStrict({
                ...accounts,
                book: multiBookPda(d.key),
                systemProgram: SystemProgram.programId,
              })
              .instruction()
          : await (
              action === "open"
                ? s.signed.methods.openMultiOutcomeMarket()
                : s.signed.methods.closeMultiOutcomeTrading()
            )
              .accountsStrict(accounts)
              .instruction();
      return new Transaction().add(ix);
    });
  const outcomeText = (o: NonNullable<typeof proposed>["outcome"]) =>
    o.winner
      ? d.market.terms.outcomeLabels[o.winner[0][0]]
      : t("Invalid (equal refunds)");
  return (
    <section aria-labelledby="multi-resolution">
      {/* The rules themselves live in the left column (MultiOutcomeRules). */}
      <h2 id="multi-resolution">{t("Resolution")}</h2>
      {!d.market.finalOutcome && !proposed && (
        <p>{t("No outcome proposed.")}</p>
      )}
      {d.market.finalOutcome && (
        <p>
          {t("Final outcome")}: {outcomeText(d.market.finalOutcome)}
        </p>
      )}
      {proposed && (
        <>
          <p>
            {t("Proposed: {outcome}. Review ends {time}.", {
              outcome: outcomeText(proposed.outcome),
              time: new Date(readyAt! * 1000).toLocaleString(),
            })}
          </p>
          <p>
            {t("Evidence")}:{" "}
            <a href={proposed.evidenceUri} target="_blank" rel="noreferrer">
              {proposed.evidenceUri}
            </a>
          </p>
          <p>
            {t("Evidence SHA-256")}:{" "}
            <code>{Buffer.from(proposed.evidenceHash).toString("hex")}</code>
          </p>
        </>
      )}
      <div className="multi-actions">
        {availability.canFreeze && (
          <button disabled={!ready} onClick={() => advance(0)}>
            {t("Freeze at cutoff")}
          </button>
        )}
        {availability.canActivateFallback && (
          <button disabled={!ready} onClick={() => advance(1)}>
            {t("Activate fallback")}
          </button>
        )}
        {availability.canFinalize && (
          <button disabled={!ready} onClick={() => advance(2)}>
            {t("Finalize outcome")}
          </button>
        )}
        {availability.canTimeout && (
          <button disabled={!ready} onClick={() => advance(3)}>
            {t("Finalize timeout as Invalid")}
          </button>
        )}
      </div>
      {availability.canPropose && (
        <form
          aria-label={t("Resolution proposal")}
          onSubmit={(e) => {
            e.preventDefault();
            void s.send(async () => {
              if (!s.signed || !s.wallet) throw new Error("Connect a wallet.");
              const url = new URL(uri);
              if (!["https:", "ar:"].includes(url.protocol))
                throw new Error("Use an HTTPS or Arweave evidence URI.");
              if (!/^[a-fA-F0-9]{64}$/.test(hash) || /^0+$/.test(hash))
                throw new Error(
                  "Enter the SHA-256 of the exact published evidence bytes.",
                );
              const outcome =
                result === "invalid"
                  ? { invalid: {} }
                  : { winner: [[Number(result)]] };
              return new Transaction().add(
                await s.signed.methods
                  .proposeMultiOutcome(
                    outcome,
                    uri,
                    [...Buffer.from(hash, "hex")],
                    !!proposed,
                  )
                  .accountsStrict({
                    resolver: s.wallet.publicKey,
                    market: d.key,
                    adminRecord: deriveAdminRecordPda(s.wallet.publicKey),
                  })
                  .instruction(),
              );
            });
          }}
        >
          <h3>{t(proposed ? "Correct proposal" : "Propose outcome")}</h3>
          <label>
            {t("Outcome")}
            <select value={result} onChange={(e) => setResult(e.target.value)}>
              <option value="invalid">{t("Invalid — equal refunds")}</option>
              {d.market.terms.outcomeLabels.map((v, i) => (
                <option key={i} value={i}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Evidence URI")}
            <input
              type="url"
              required
              maxLength={200}
              value={uri}
              onChange={(e) => setUri(e.target.value)}
            />
          </label>
          <label>
            {t("Evidence SHA-256")}
            <input
              required
              pattern="[a-fA-F0-9]{64}"
              value={hash}
              onChange={(e) => setHash(e.target.value)}
            />
          </label>
          <p>{t("Corrections restart the full review delay.")}</p>
          <button disabled={!ready}>{t("Review proposal in wallet")}</button>
        </form>
      )}
      {creator && (
        <details>
          <summary>{t("Manage market")}</summary>
          <div className="multi-actions">
            {!d.book && (
              <button
                disabled={!ready || closed}
                onClick={() => manage("book")}
              >
                {t("Initialize order book")}
              </button>
            )}
            {"draft" in d.market.status && (
              <button
                disabled={!ready || closed || !d.book}
                onClick={() => manage("open")}
              >
                {t("Open trading")}
              </button>
            )}
            {"open" in d.market.status && (
              <button disabled={!ready} onClick={() => manage("close")}>
                {t("Close trading")}
              </button>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
