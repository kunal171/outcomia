"use client";
import { useState } from "react";
import { Transaction } from "@solana/web3.js";
import { custody, whole } from "../../lib/multi-outcome";
import type { MultiSession } from "./use-market";
export function MultiPositions({ session: s }: { session: MultiSession }) {
  const [quantity, setQuantity] = useState("");
  const d = s.data;
  if (!d) return null;
  const ready =
    !!s.signed &&
    !!s.wallet &&
    !!d.position &&
    !!d.cash &&
    !s.busy &&
    !s.loading;
  const resolved = "resolved" in d.market.status,
    open =
      "open" in d.market.status &&
      Date.now() < d.market.terms.closeTs.toNumber() * 1000;
  const winner = d.market.finalOutcome?.winner?.[0][0];
  return (
    <section aria-labelledby="multi-positions">
      <h2 id="multi-positions">Your positions</h2>
      <div className="multi-scroll">
        <table>
          <thead>
            <tr>
              <th>Outcome</th>
              <th>Available</th>
              <th>Locked</th>
              <th>Final payout</th>
            </tr>
          </thead>
          <tbody>
            {d.market.terms.outcomeLabels.map((label, i) => (
              <tr key={i}>
                <th>{label}</th>
                <td>{d.position?.free[i].toString() ?? "—"}</td>
                <td>{d.position?.locked[i].toString() ?? "—"}</td>
                <td>
                  {!resolved
                    ? "Pending"
                    : winner === i
                      ? "1 collateral token"
                      : winner !== undefined
                        ? "0"
                        : `1/${d.market.terms.outcomeLabels.length} collateral token`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Cancel sell orders to release locked contracts before merging or
        redeeming. Claims credit your shared wallet balance.
      </p>
      {resolved ? (
        <button
          disabled={!ready || !d.position?.free.some((q) => !q.isZero())}
          onClick={() =>
            void s.send(async () => {
              if (!s.signed || !s.wallet || !d.position)
                throw new Error("Initialize your accounts.");
              return new Transaction().add(
                await s.signed.methods
                  .redeemMultiOutcome(d.position.free)
                  .accountsStrict(
                    custody(d.key, s.wallet.publicKey, d.market.collateralMint),
                  )
                  .instruction(),
              );
            })
          }
        >
          Redeem available contracts
        </button>
      ) : (
        <details>
          <summary>Create or merge complete sets</summary>
          <p>
            One complete set contains one contract of every outcome. Splitting
            locks one collateral token per set; merging returns it. The minimum
            lot is {d.market.terms.quantityLot.toString()}.
          </p>
          <label>
            Complete sets
            <input
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
          <div className="multi-actions">
            {[true, false].map((split) => (
              <button
                key={String(split)}
                disabled={
                  !ready ||
                  (split && !open) ||
                  (!split &&
                    !(
                      "open" in d.market.status ||
                      "frozen" in d.market.status ||
                      "proposed" in d.market.status
                    ))
                }
                onClick={() =>
                  void s.send(async () => {
                    if (!s.signed || !s.wallet)
                      throw new Error("Connect a wallet.");
                    const q = whole(quantity);
                    if (!q.mod(d.market.terms.quantityLot).isZero())
                      throw new Error(
                        "Quantity must follow the complete-set lot.",
                      );
                    return new Transaction().add(
                      await s.signed.methods
                        .multiOutcomeCompleteSet(q, split)
                        .accountsStrict(
                          custody(
                            d.key,
                            s.wallet.publicKey,
                            d.market.collateralMint,
                          ),
                        )
                        .instruction(),
                    );
                  })
                }
              >
                {split ? "Create complete sets" : "Merge complete sets"}
              </button>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
