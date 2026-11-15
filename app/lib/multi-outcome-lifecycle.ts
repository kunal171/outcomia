import { BN } from "@anchor-lang/core";
import type { PublicKey } from "@solana/web3.js";
import type { MultiMarket } from "./multi-outcome";
/** Mirrors the program's stored resolution phase and exclusive proposal windows.
 * Ledger checks remain authoritative when time or state changes before submission. */
export function resolutionAvailability(
  m: MultiMarket,
  party: PublicKey | null,
  admin: boolean,
  now: number,
) {
  const at = new BN(now),
    t = m.terms,
    f = t.fallback,
    proposed = m.proposal;
  const resolved = "resolved" in m.status || m.finalOutcome !== null;
  const awaiting =
    ("open" in m.status || "frozen" in m.status) && !proposed && !resolved;
  const fallbackPhase = "fallback" in m.resolutionPhase;
  const earliest = t.earliestResolutionTs ?? t.closeTs;
  const afterClose = at.gte(t.closeTs) && at.gte(earliest);
  const inWindow = fallbackPhase
    ? !!f && at.gte(f.availableTs) && (!f.deadlineTs || at.lt(f.deadlineTs))
    : !f || at.lt(f.availableTs);
  const resolver = fallbackPhase ? f?.resolver : t.resolver;
  const matureAt = proposed
    ? proposed.proposedAt.add(t.resolutionDelaySeconds)
    : null;
  const canCorrect =
    !!proposed &&
    "proposed" in m.status &&
    !!matureAt &&
    at.lt(matureAt) &&
    !resolved;
  return {
    canPropose:
      admin &&
      !!party &&
      !!resolver?.equals(party) &&
      afterClose &&
      inWindow &&
      (awaiting || canCorrect),
    canFreeze: !resolved && "open" in m.status && at.gte(t.closeTs),
    canActivateFallback:
      awaiting &&
      !fallbackPhase &&
      !!f &&
      at.gte(f.availableTs) &&
      (!f.deadlineTs || at.lt(f.deadlineTs)),
    canFinalize:
      !resolved && "proposed" in m.status && !!matureAt && at.gte(matureAt),
    canTimeout: awaiting && !!f?.deadlineTs && at.gte(f.deadlineTs),
    matureAt,
  };
}
