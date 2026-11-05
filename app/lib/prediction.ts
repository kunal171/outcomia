/** Prediction accounts, exact addresses, rule validation and resting-order preflight. */
import { BN } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./solana";
import type { OrderSide } from "./tidebook";

export type PredictionOutcome = "yes" | "no";

export const PREDICTION_ORDERS_ENABLED =
  process.env.NEXT_PUBLIC_PREDICTION_DRAFTS_ENABLED === "true" &&
  process.env.NEXT_PUBLIC_PREDICTION_FUNDING_ENABLED === "true" &&
  process.env.NEXT_PUBLIC_PREDICTION_ORDERS_ENABLED === "true";

export function predictionBestPrice(
  book: PredictionOrderBookAccount,
  outcome: PredictionOutcome,
  side: OrderSide,
): BN | null {
  return outcome === "yes"
    ? side === "bid"
      ? book.yesBestBid
      : book.yesBestAsk
    : side === "bid"
      ? book.noBestBid
      : book.noBestAsk;
}

/** Advisory empty-side placement checks; all arithmetic stays exact in BN. */
export function validatePredictionRestingOrder(
  market: PredictionMarketAccount,
  book: PredictionOrderBookAccount,
  position: PredictionPositionAccount,
  outcome: PredictionOutcome,
  side: OrderSide,
  price: BN,
  quantity: BN,
  now: BN,
): BN {
  if (!["yes", "no"].includes(outcome) || !["bid", "ask"].includes(side))
    throw new Error("Select a valid outcome and side");
  if (!book.market.equals(position.market))
    throw new Error("Book and position belong to different markets");
  if (predictionStatus(market) !== "open" || now.gte(market.closeTs))
    throw new Error("Orders require an open market before close");
  if (quantity.isNeg() || quantity.isZero() || quantity.bitLength() > 64)
    throw new Error("Quantity must be a positive whole u64 contract count");
  if (
    price.isNeg() ||
    price.isZero() ||
    price.bitLength() > 64 ||
    price.gte(market.payoutPerContract) ||
    market.priceTick.isZero() ||
    !price.mod(market.priceTick).isZero()
  )
    throw new Error("Price must be positive, below 1 and tick-aligned");
  if (predictionBestPrice(book, outcome, side) !== null)
    throw new Error("This step supports only the first order on an empty side");
  const opposing = predictionBestPrice(
    book,
    outcome,
    side === "bid" ? "ask" : "bid",
  );
  if (opposing && (side === "bid" ? price.gte(opposing) : price.lte(opposing)))
    throw new Error(
      "This order would cross; prediction matching is not available yet",
    );
  if (
    book.nextOrderId.lte(new BN(0)) ||
    book.nextOrderId.addn(1).bitLength() > 64 ||
    market.openOrderCount.addn(1).bitLength() > 64
  )
    throw new Error("Order counter limit reached");
  const amount = side === "bid" ? price.mul(quantity) : quantity;
  if (amount.bitLength() > 64) throw new Error("Order collateral exceeds u64");
  const free =
    side === "bid"
      ? position.collateralFree
      : outcome === "yes"
        ? position.yesFree
        : position.noFree;
  const locked =
    side === "bid"
      ? position.collateralLocked
      : outcome === "yes"
        ? position.yesLocked
        : position.noLocked;
  if (amount.gt(free))
    throw new Error(
      side === "bid"
        ? "Not enough available collateral"
        : `Not enough available ${outcome.toUpperCase()} contracts`,
    );
  if (locked.add(amount).bitLength() > 64)
    throw new Error("Locked balance limit reached");
  return amount;
}

/** Created atomically with new drafts; each head selects one outcome/side list. */
export interface PredictionOrderBookAccount {
  market: PublicKey;
  nextOrderId: BN;
  yesBestBid: BN | null;
  yesBestAsk: BN | null;
  noBestBid: BN | null;
  noBestAsk: BN | null;
  bump: number;
}

export interface PredictionPriceLevelAccount {
  market: PublicKey;
  outcome: { yes?: object; no?: object };
  side: { bid?: object; ask?: object };
  price: BN;
  betterPrice: BN | null;
  worsePrice: BN | null;
  firstOrder: PublicKey | null;
  lastOrder: PublicKey | null;
  totalRemainingQuantity: BN;
  orderCount: BN;
  rentPayer: PublicKey;
  bump: number;
}

export interface PredictionOrderAccount {
  owner: PublicKey;
  market: PublicKey;
  orderId: BN;
  outcome: { yes?: object; no?: object };
  side: { bid?: object; ask?: object };
  price: BN;
  priceLevel: PublicKey;
  previousOrder: PublicKey | null;
  nextOrder: PublicKey | null;
  quantity: BN;
  remainingQuantity: BN;
  /** Bid collateral atoms (including any fee budget), or ask outcome contracts. */
  lockedCollateral: BN;
  status: { open?: object; filled?: object; canceled?: object };
  bump: number;
}

/** Encode full-width unsigned seeds without converting through JS Number. */
function predictionU64Seed(value: BN, label: string): Buffer {
  if (value.isNeg() || value.bitLength() > 64)
    throw new Error(`${label} must fit unsigned u64`);
  return value.toArrayLike(Buffer, "le", 8);
}

export function derivePredictionBookPda(market: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("prediction_book"), market.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function derivePredictionOrderPda(market: PublicKey, orderId: BN) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("prediction_order"),
      market.toBuffer(),
      predictionU64Seed(orderId, "Order ID"),
    ],
    PROGRAM_ID,
  )[0];
}

export function derivePredictionPriceLevelPda(
  market: PublicKey,
  outcome: PredictionOutcome,
  side: OrderSide,
  price: BN,
) {
  // TypeScript types are erased; reject unknown namespaces from JS callers too.
  if (outcome !== "yes" && outcome !== "no")
    throw new Error("Outcome must be yes or no");
  if (side !== "bid" && side !== "ask")
    throw new Error("Side must be bid or ask");
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("prediction_level"),
      market.toBuffer(),
      Buffer.from(outcome),
      Buffer.from(side),
      predictionU64Seed(price, "Price"),
    ],
    PROGRAM_ID,
  )[0];
}

export const PREDICTION_DRAFTS_ENABLED =
  process.env.NEXT_PUBLIC_PREDICTION_DRAFTS_ENABLED === "true";

// Separate rollout from draft creation so older deployments cannot expose an
// opening button for an instruction their binary does not understand.
export const PREDICTION_OPENING_ENABLED =
  PREDICTION_DRAFTS_ENABLED &&
  process.env.NEXT_PUBLIC_PREDICTION_OPENING_ENABLED === "true";

/** Advisory preflight. Chain Clock and the stored signer binding are authoritative. */
export function predictionOpeningIssue(
  market: PredictionMarketAccount,
  authority: PublicKey,
  now: BN,
  activeAdmin: boolean,
): string | null {
  if (!market.authority.equals(authority))
    return "Only the market authority can open this draft";
  if (!activeAdmin)
    return "An active administrator role is required to open this draft";
  if (!market.resolver.equals(authority))
    return "The market creator must be its primary outcome resolver";
  if (predictionStatus(market) !== "draft")
    return "Only a draft market can be opened";
  if (now.gte(market.closeTs))
    return "The market close time has already been reached";
  return null;
}

/** Bind the uploaded primary resolver to the creator without rewriting rule bytes. */
export function validatePredictionCreatorResolver(
  resolver: PublicKey,
  creator: PublicKey,
): void {
  if (!resolver.equals(creator))
    throw new Error(
      "Rules primaryResolver must match the market creator wallet",
    );
}

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
