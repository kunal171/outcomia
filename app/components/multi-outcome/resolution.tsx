"use client";
import { useState } from "react";
import { Transaction, SystemProgram } from "@solana/web3.js";
import { deriveAdminRecordPda } from "../../lib/outcomia";
import { multiBookPda } from "../../lib/multi-outcome";
import { useProtocolRole } from "../protocol-role-provider";
import type { MultiSession } from "./use-market";
export function MultiResolution({ session: s }: { session: MultiSession }) {
  const [result, setResult] = useState("invalid"),
    [uri, setUri] = useState(""),
    [hash, setHash] = useState("");
  const { role } = useProtocolRole(),
    d = s.data;
  if (!d) return null;
  const ready = !!s.wallet && !!s.signed && !s.busy && !s.loading,
    admin = role === "admin" || role === "super-admin";
  const creator = admin && !!s.wallet?.publicKey.equals(d.market.authority);
  const now = Math.floor(Date.now() / 1000),
    closed = now >= d.market.terms.closeTs.toNumber();
  const fallback = d.market.terms.fallback;
  const resolver =
    admin &&
    !!s.wallet?.publicKey.equals(
      fallback && now >= fallback.availableTs.toNumber()
        ? fallback.resolver
        : d.market.terms.resolver,
    );
  const proposed = d.market.proposal,
    readyAt = proposed
      ? proposed.proposedAt
          .add(d.market.terms.resolutionDelaySeconds)
          .toNumber()
      : null;
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
      : "Invalid (equal refunds)";
  return (
    <section aria-labelledby="multi-resolution">
      <h2 id="multi-resolution">Rules & outcome</h2>
      <p>
        Published rules:{" "}
        <a href={d.market.terms.rulesUri} target="_blank" rel="noreferrer">
          {d.market.terms.rulesUri}
        </a>
      </p>
      <p>
        Rules SHA-256:{" "}
        <code>{Buffer.from(d.market.terms.rulesHash).toString("hex")}</code>
      </p>
      {d.market.finalOutcome && (
        <p>Final outcome: {outcomeText(d.market.finalOutcome)}</p>
      )}
      {proposed && (
        <>
          <p>
            Proposed: {outcomeText(proposed.outcome)}. Review ends{" "}
            {new Date(readyAt! * 1000).toLocaleString()}.
          </p>
          <p>
            Evidence:{" "}
            <a href={proposed.evidenceUri} target="_blank" rel="noreferrer">
              {proposed.evidenceUri}
            </a>
          </p>
          <p>
            Evidence SHA-256:{" "}
            <code>{Buffer.from(proposed.evidenceHash).toString("hex")}</code>
          </p>
        </>
      )}
      <div className="multi-actions">
        {"open" in d.market.status && (
          <button disabled={!ready || !closed} onClick={() => advance(0)}>
            Freeze at cutoff
          </button>
        )}
        {fallback && !("resolved" in d.market.status) && !proposed && (
          <button
            disabled={!ready || now < fallback.availableTs.toNumber()}
            onClick={() => advance(1)}
          >
            Activate fallback
          </button>
        )}
        {proposed && !("resolved" in d.market.status) && (
          <button
            disabled={!ready || now < readyAt!}
            onClick={() => advance(2)}
          >
            Finalize outcome
          </button>
        )}
        {fallback?.deadlineTs &&
          !proposed &&
          !("resolved" in d.market.status) && (
            <button
              disabled={!ready || now < fallback.deadlineTs.toNumber()}
              onClick={() => advance(3)}
            >
              Finalize timeout as Invalid
            </button>
          )}
      </div>
      {resolver && closed && !("resolved" in d.market.status) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void s.send(async () => {
              if (!s.signed || !s.wallet) throw new Error("Connect a wallet.");
              const url = new URL(uri);
              if (!["https:", "ar:", "ipfs:"].includes(url.protocol))
                throw new Error("Use an HTTPS, Arweave or IPFS evidence URI.");
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
          <h3>{proposed ? "Correct proposal" : "Propose outcome"}</h3>
          <label>
            Outcome
            <select value={result} onChange={(e) => setResult(e.target.value)}>
              <option value="invalid">Invalid — equal refunds</option>
              {d.market.terms.outcomeLabels.map((v, i) => (
                <option key={i} value={i}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Evidence URI
            <input
              type="url"
              required
              maxLength={200}
              value={uri}
              onChange={(e) => setUri(e.target.value)}
            />
          </label>
          <label>
            Evidence SHA-256
            <input
              required
              pattern="[a-fA-F0-9]{64}"
              value={hash}
              onChange={(e) => setHash(e.target.value)}
            />
          </label>
          <p>Corrections restart the full review delay.</p>
          <button disabled={!ready || (readyAt !== null && now >= readyAt)}>
            Review proposal in wallet
          </button>
        </form>
      )}
      {creator && (
        <details>
          <summary>Manage market</summary>
          <div className="multi-actions">
            {!d.book && (
              <button
                disabled={!ready || closed}
                onClick={() => manage("book")}
              >
                Initialize order book
              </button>
            )}
            {"draft" in d.market.status && (
              <button
                disabled={!ready || closed || !d.book}
                onClick={() => manage("open")}
              >
                Open trading
              </button>
            )}
            {"open" in d.market.status && (
              <button disabled={!ready} onClick={() => manage("close")}>
                Close trading
              </button>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
