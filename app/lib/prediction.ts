/** Prediction draft types and rule-file validation. No trading routes yet. */
import { BN } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./solana";

export const PREDICTION_DRAFTS_ENABLED =
  process.env.NEXT_PUBLIC_PREDICTION_DRAFTS_ENABLED === "true";

// Enable only against a deployment containing deposits, withdrawals and sets.
export const PREDICTION_FUNDING_ENABLED =
  PREDICTION_DRAFTS_ENABLED &&
  process.env.NEXT_PUBLIC_PREDICTION_FUNDING_ENABLED === "true";

/** Preflight bounds only; on-chain custody and ledger checks remain required. */
export function validatePredictionDepositAmount(
  amount: BN,
  walletBalance: BN | null,
  collateralFree: BN,
): BN {
  if (amount.isNeg() || amount.isZero() || amount.bitLength() > 64)
    throw new Error("Deposit must be a positive u64 amount");
  if (walletBalance === null)
    throw new Error("Wallet collateral balance is unavailable");
  if (amount.gt(walletBalance))
    throw new Error("Deposit exceeds your wallet collateral balance");
  if (collateralFree.add(amount).bitLength() > 64)
    throw new Error("Deposit would exceed the position balance limit");
  return amount;
}

/** Withdrawals spend cash only; wallet RPC errors must not block cash recovery. */
export function validatePredictionWithdrawalAmount(
  amount: BN,
  collateralFree: BN,
): BN {
  if (amount.isNeg() || amount.isZero() || amount.bitLength() > 64)
    throw new Error("Withdrawal must be a positive u64 amount");
  if (amount.gt(collateralFree))
    throw new Error("Withdrawal exceeds your available collateral");
  return amount;
}

/** Whole pairs only. BN arithmetic preserves exact u64 collateral quantities. */
export function validatePredictionCompleteSet(
  quantity: BN,
  position: PredictionPositionAccount,
  market: PredictionMarketAccount,
  action: "split" | "merge",
  now: BN,
): BN {
  if (quantity.isNeg() || quantity.isZero() || quantity.bitLength() > 64)
    throw new Error("Quantity must be a positive whole u64 contract count");
  const status = predictionStatus(market);
  if (action === "split" && (status !== "open" || now.gte(market.closeTs)))
    throw new Error("Splitting requires an open market before its close time");
  if (action === "merge" && !["open", "frozen", "proposed"].includes(status))
    throw new Error("Merging requires an open, frozen or proposed market");
  const collateral = quantity.mul(market.payoutPerContract);
  if (collateral.bitLength() > 64)
    throw new Error("Collateral amount exceeds u64");
  if (action === "split") {
    if (collateral.gt(position.collateralFree))
      throw new Error("Not enough available collateral to split");
    if (
      [
        position.yesFree.add(quantity),
        position.noFree.add(quantity),
        market.yesSupply.add(quantity),
        market.noSupply.add(quantity),
        market.backingReserve.add(collateral),
      ].some((value) => value.bitLength() > 64)
    )
      throw new Error("Splitting would exceed a position or reserve limit");
  } else {
    if (quantity.gt(position.yesFree) || quantity.gt(position.noFree))
      throw new Error("Not enough available YES and NO positions to merge");
    if (
      quantity.gt(market.yesSupply) ||
      quantity.gt(market.noSupply) ||
      collateral.gt(market.backingReserve)
    )
      throw new Error("Market backing cannot cover this merge");
    if (position.collateralFree.add(collateral).bitLength() > 64)
      throw new Error("Merge would exceed the available collateral limit");
  }
  return collateral;
}

/** Collateral fields use mint atoms; YES/NO fields count whole contracts. */
export interface PredictionPositionAccount {
  market: PublicKey;
  owner: PublicKey;
  collateralFree: BN;
  collateralLocked: BN;
  yesFree: BN;
  yesLocked: BN;
  noFree: BN;
  noLocked: BN;
  bump: number;
}

export interface PredictionMarketAccount {
  marketId: number[];
  authority: PublicKey;
  resolver: PublicKey;
  fallback: {
    resolver: PublicKey;
    availableTs: BN;
    deadlineTs: BN | null;
  } | null;
  collateralMint: PublicKey;
  collateralVault: PublicKey;
  metadata: PublicKey;
  questionHash: number[];
  rulesHash: number[];
  rulesUri: string;
  closeTs: BN;
  earliestResolutionTs: BN | null;
  resolutionDelaySeconds: BN;
  resolutionPhase: { primary?: object; fallback?: object };
  status: {
    draft?: object;
    open?: object;
    frozen?: object;
    proposed?: object;
    resolved?: object;
  };
  proposal: {
    outcome: { yes?: object; no?: object; invalid?: object };
    proposedAt: BN;
    evidenceUri: string;
    evidenceHash: number[];
  } | null;
  finalOutcome: { yes?: object; no?: object; invalid?: object } | null;
  payoutPerContract: BN;
  priceTick: BN;
  yesSupply: BN;
  noSupply: BN;
  backingReserve: BN;
  openOrderCount: BN;
  bump: number;
}

export function derivePredictionMarketPda(marketId: Uint8Array) {
  if (marketId.length !== 32)
    throw new Error("Market ID must contain 32 bytes");
  return PublicKey.findProgramAddressSync(
    [Buffer.from("prediction_market"), Buffer.from(marketId)],
    PROGRAM_ID,
  )[0];
}

/** Must match Rust's [prediction_position, market, owner] seed order. */
export function derivePredictionPositionPda(
  market: PublicKey,
  owner: PublicKey,
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("prediction_position"), market.toBuffer(), owner.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required`);
  return value;
}

function timestamp(value: unknown, label: string): BN {
  // JSON timestamps use safe integer Unix seconds; never silently round them.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be nonnegative integer Unix seconds`);
  }
  return new BN(String(value));
}

/** Hash original uploaded bytes; parsing/reformatting JSON would change its hash. */
export async function parsePredictionRules(bytes: ArrayBuffer) {
  if (bytes.byteLength > 128 * 1024)
    throw new Error("Rules file exceeds 128 KiB");
  const rules = object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    "Rules",
  );
  if (rules.schemaVersion !== 1) throw new Error("Use rules schemaVersion 1");
  const question = text(rules.question, "Question");
  text(rules.resolutionSource, "Resolution source");
  const criteria = object(rules.resolutionRules, "Resolution rules");
  for (const key of [
    "yesCriteria",
    "noCriteria",
    "invalidCriteria",
    "evidenceRequirements",
    "conflictingEvidencePolicy",
  ]) {
    text(criteria[key], key);
  }
  const closeTs = timestamp(rules.closeTimestamp, "Close timestamp");
  const earliestResolutionTs =
    rules.earliestResolutionTimestamp == null
      ? null
      : timestamp(rules.earliestResolutionTimestamp, "Earliest resolution");
  const effective = earliestResolutionTs ?? closeTs;
  if (effective.lt(closeTs))
    throw new Error("Resolution cannot start before trading closes");
  const resolver = new PublicKey(
    text(rules.primaryResolver, "Primary resolver"),
  );
  if (resolver.equals(PublicKey.default))
    throw new Error("Primary resolver cannot be zero");
  let fallback: PredictionMarketAccount["fallback"] = null;
  if (rules.fallback != null) {
    const policy = object(rules.fallback, "Fallback");
    const key = new PublicKey(text(policy.resolver, "Fallback resolver"));
    const availableTs = timestamp(
      policy.availableTimestamp,
      "Fallback activation",
    );
    const deadlineTs =
      policy.proposalDeadlineTimestamp == null
        ? null
        : timestamp(policy.proposalDeadlineTimestamp, "Fallback deadline");
    if (key.equals(PublicKey.default) || key.equals(resolver))
      throw new Error("Fallback must use a different nonzero resolver");
    if (
      availableTs.lte(effective) ||
      (deadlineTs && deadlineTs.lte(availableTs))
    ) {
      throw new Error(
        "Fallback times must follow the resolution start in order",
      );
    }
    text(policy.procedure, "Fallback procedure");
    // These strings are part of schema v1's contract. Reject a document that
    // promises a different timeout than the current program implements.
    if (
      policy.activation !== "No primary proposal exists at the activation time"
    ) {
      throw new Error("Fallback activation does not match the program policy");
    }
    const expected = deadlineTs
      ? "Invalid after the proposal deadline"
      : "No automatic timeout; await resolver";
    if (policy.noProposalOutcome !== expected)
      throw new Error("Fallback timeout policy does not match the program");
    fallback = { resolver: key, availableTs, deadlineTs };
  }
  const resolutionDelaySeconds = timestamp(
    rules.resolutionDelaySeconds,
    "Resolution delay",
  );
  if (resolutionDelaySeconds.isZero())
    throw new Error("Resolution delay must be positive");
  const rulesHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
  const questionBytes = new TextEncoder().encode(question);
  const questionHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", questionBytes)),
  );
  return {
    question,
    resolver,
    fallback,
    closeTs,
    earliestResolutionTs,
    resolutionDelaySeconds,
    rulesHash,
    questionHash,
  };
}

export function predictionStatus(market: PredictionMarketAccount) {
  return Object.keys(market.status)[0] ?? "unknown";
}

export function predictionTime(value: BN | null) {
  if (!value) return "Not configured";
  const seconds = Number(value.toString());
  const date = new Date(seconds * 1000);
  return Number.isSafeInteger(seconds) && !Number.isNaN(date.getTime())
    ? date.toISOString().replace("T", " ").replace(".000Z", " UTC")
    : `${value.toString()} Unix seconds`;
}
