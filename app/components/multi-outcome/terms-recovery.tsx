"use client";
import { useEffect, useState } from "react";
import { AnchorProvider, type Program } from "@anchor-lang/core";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  MULTI_OUTCOME_ENABLED,
  multiAccounts,
  transactionBytes,
} from "../../lib/multi-outcome";
import { termsBufferPda } from "../../lib/multi-outcome-creation";
/** Discover abandoned uploads on-ledger, so reloads and storage loss cannot hide rent recovery. */
export function TermsRecovery({
  program,
  owner,
  revision,
  disabled,
}: {
  program: Program | null;
  owner: PublicKey | null;
  revision: number;
  disabled: boolean;
}) {
  const [buffers, setBuffers] = useState<PublicKey[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const identity = owner?.toBase58() ?? "";
  useEffect(() => {
    let active = true;
    setBuffers([]);
    setError("");
    if (!MULTI_OUTCOME_ENABLED || !program || !owner) return;
    void multiAccounts(program)
      .multiOutcomeTermsBuffer.all([
        { memcmp: { offset: 8, bytes: owner.toBase58() } },
      ])
      .then((rows) => {
        if (active)
          setBuffers(
            rows
              .filter(
                (r) =>
                  r.account.authority.equals(owner) &&
                  termsBufferPda(
                    owner,
                    Uint8Array.from(r.account.marketId),
                  ).equals(r.publicKey),
              )
              .map((r) => r.publicKey),
          );
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [program, identity, revision, refresh]);
  if (!buffers.length && !error) return null;
  return (
    <details>
      <summary>Recover uploaded-term rent</summary>
      <p>
        Closing a buffer discards only uploaded draft terms. A created market
        keeps its immutable terms.
      </p>
      {error && <p role="alert">{error}</p>}
      {buffers.map((buffer) => (
        <p key={buffer.toBase58()}>
          <code>{buffer.toBase58()}</code>{" "}
          <button
            disabled={disabled || busy}
            onClick={() => {
              if (!program || !owner || busy) return;
              setBusy(true);
              setError("");
              void (async () => {
                try {
                  const tx = new Transaction().add(
                    await program.methods
                      .closeMultiOutcomeTerms()
                      .accountsStrict({ authority: owner, buffer })
                      .instruction(),
                  );
                  transactionBytes(tx, owner);
                  await (program.provider as AnchorProvider).sendAndConfirm(tx);
                  setRefresh((v) => v + 1);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            Close upload and recover rent
          </button>
        </p>
      ))}
    </details>
  );
}
