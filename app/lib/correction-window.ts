import { BN } from "@anchor-lang/core";

/** Mirrors the program's `CORRECTION_WINDOW_DELAYS`. */
export const CORRECTION_WINDOW_DELAYS = 2;

/** Schedule fields shared by binary and multi-outcome markets. */
export type CorrectionSchedule = {
  closeTs: BN;
  earliestResolutionTs: BN | null;
  resolutionDelaySeconds: BN;
  fallbackPhase: boolean;
  fallbackAvailableTs: BN | null;
};

/**
 * Mirrors the program's `correction_deadline`: the current resolver may correct
 * only before its phase start (earliest resolution time for the primary,
 * fallback availability for the fallback) plus two review delays. Without this
 * bound, each correction restarting the delay could block finalization forever.
 * The ledger stays authoritative if state or time changes before submission.
 *
 * Returns: the exclusive deadline in Unix seconds.
 */
export function correctionDeadline(schedule: CorrectionSchedule): BN {
  const start =
    schedule.fallbackPhase && schedule.fallbackAvailableTs
      ? schedule.fallbackAvailableTs
      : (schedule.earliestResolutionTs ?? schedule.closeTs);
  return start.add(
    schedule.resolutionDelaySeconds.muln(CORRECTION_WINDOW_DELAYS),
  );
}

/** Whether a pending proposal can still be corrected at `now`. */
export function correctionOpen(
  schedule: CorrectionSchedule,
  maturity: BN | null,
  now: BN,
): boolean {
  return !!maturity && now.lt(maturity) && now.lt(correctionDeadline(schedule));
}
