/** Bounded prediction matching over a disposable, read-only account overlay. */
import { BN, type Program } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  derivePredictionBookPda,
  derivePredictionPositionPda,
  predictionBestPrice,
  predictionStatus,
  readPredictionMatchTarget,
  validatePredictionMatch,
  type PredictionMarketAccount,
  type PredictionMatchTarget,
  type PredictionOrderAccount,
  type PredictionOrderBookAccount,
  type PredictionOutcome,
  type PredictionPositionAccount,
  type PredictionPriceLevelAccount,
} from "./prediction";
import {
  deriveMarketFeesPda,
  deriveProtocolConfigPda,
  type OrderSide,
} from "./outcomia";

export const MAX_PREDICTION_MATCHES_PER_TRANSACTION = 3;
// A fixed ceiling bounds the batch. Preflight still determines whether the
// actual transaction fits; this is not a guarantee for future program changes.
export const PREDICTION_MATCH_COMPUTE_UNITS = 600_000;
const U64_MAX = new BN("18446744073709551615");

interface AccountReader<T> {
  fetchNullable(address: PublicKey): Promise<T | null>;
}

export interface PredictionMatchingReader {
  predictionOrder: AccountReader<PredictionOrderAccount>;
  predictionPriceLevel: AccountReader<PredictionPriceLevelAccount>;
  predictionPosition: AccountReader<PredictionPositionAccount>;
}

export interface PredictionMatchRequest {
  marketAddress: PublicKey;
  taker: PublicKey;
  outcome: PredictionOutcome;
  side: OrderSide;
  limitPrice: BN;
  quantity: BN;
}

export type PredictionMatchStopReason =
  | "filled"
  | "book-exhausted"
  | "non-crossing"
  | "match-cap";

export interface PredictionMatchStep {
  /** Snapshot after simulating earlier steps, before this step executes. */
  target: PredictionMatchTarget;
  requestedQuantity: BN;
  fillQuantity: BN;
  notional: BN;
  fee: BN;
}

export interface PredictionMatchPlan {
  request: PredictionMatchRequest;
  steps: PredictionMatchStep[];
  remainingQuantity: BN;
  totalNotional: BN;
  totalFee: BN;
  /** Total taker cash paid (buy) or received (sell), including fees. */
  totalCash: BN;
  stopReason: PredictionMatchStopReason;
  /** Disposable final snapshots for funding and non-crossing remainder checks. */
  finalMarket: PredictionMarketAccount;
  finalBook: PredictionOrderBookAccount;
  finalPosition: PredictionPositionAccount;
}

/** A cap-blocked request must never rest across still-crossing liquidity. */
export function canPostPredictionRemainder(plan: PredictionMatchPlan): boolean {
  return (
    plan.remainingQuantity.gtn(0) &&
    (plan.stopReason === "book-exhausted" || plan.stopReason === "non-crossing")
  );
}

/** Reject invalid requests even when there is no opposing liquidity. */
function validateRequest(
  request: PredictionMatchRequest,
  market: PredictionMarketAccount,
  book: PredictionOrderBookAccount,
  position: PredictionPositionAccount,
  feeBps: number,
  accruedFees: BN,
  now: BN,
) {
  if (
    !["yes", "no"].includes(request.outcome) ||
    !["bid", "ask"].includes(request.side)
  )
    throw new Error("Invalid outcome or side");
  if (
    !book.market.equals(request.marketAddress) ||
    !position.market.equals(request.marketAddress) ||
    !position.owner.equals(request.taker)
  )
    throw new Error("Book or position ownership mismatch");
  if (predictionStatus(market) !== "open" || now.gte(market.closeTs))
    throw new Error("Trading requires an open market before close");
  if (request.quantity.lten(0) || request.quantity.gt(U64_MAX))
    throw new Error("Quantity must be a positive whole u64");
  const price = request.limitPrice;
  if (
    price.lten(0) ||
    price.gt(U64_MAX) ||
    price.gte(market.payoutPerContract) ||
    market.priceTick.lten(0) ||
    !price.mod(market.priceTick).isZero()
  )
    throw new Error("Limit price must be positive, below 1 and tick-aligned");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000)
    throw new Error("Invalid taker fee rate");
  checkedU64(accruedFees, "Accrued fees");
}

/** BN can represent more than an account's u64; reject instead of truncating. */
function checkedU64(value: BN, label: string): BN {
  if (value.isNeg() || value.gt(U64_MAX))
    throw new Error(`${label} exceeds u64 bounds`);
  return value;
}

/** Inputs: current RPC snapshots, request, fee state and timestamp.
 * Returns: at most three maker steps and an explicit stop reason.
 * Errors: invalid/stale account links, RPC errors, self-trades, insufficient
 * cumulative funding or overflow. No caller snapshot or RPC account is mutated.
 *
 * Each cached account is replaced immutably after a simulated fill. This lets
 * the existing one-maker reader validate a promoted FIFO head or price as it
 * will appear to the next on-chain instruction, without another RPC snapshot.
 * Nothing here grants authority: the program revalidates every step at execution.
 */
export async function planPredictionMatches(
  accounts: PredictionMatchingReader,
  request: PredictionMatchRequest,
  marketSnapshot: PredictionMarketAccount,
  bookSnapshot: PredictionOrderBookAccount,
  takerSnapshot: PredictionPositionAccount,
  feeBps: number,
  accruedFees: BN,
  now: BN,
): Promise<PredictionMatchPlan> {
  validateRequest(
    request,
    marketSnapshot,
    bookSnapshot,
    takerSnapshot,
    feeBps,
    accruedFees,
    now,
  );
  const market = { ...marketSnapshot };
  const book = { ...bookSnapshot };
  let taker = { ...takerSnapshot };
  let fees = accruedFees;
  const orders = new Map<string, PredictionOrderAccount | null>();
  const levels = new Map<string, PredictionPriceLevelAccount | null>();
  const positions = new Map<string, PredictionPositionAccount>();
  async function cached<T>(
    reader: AccountReader<T>,
    cache: Map<string, T | null>,
    address: PublicKey,
  ): Promise<T | null> {
    const key = address.toBase58();
    if (!cache.has(key)) {
      const value = await reader.fetchNullable(address);
      cache.set(key, value ? { ...value } : null);
    }
    return cache.get(key) ?? null;
  }
  const overlay = {
    predictionOrder: {
      fetchNullable: (address: PublicKey) =>
        cached(accounts.predictionOrder, orders, address),
    },
    predictionPriceLevel: {
      fetchNullable: (address: PublicKey) =>
        cached(accounts.predictionPriceLevel, levels, address),
    },
  };
  const steps: PredictionMatchStep[] = [];
  let remaining = request.quantity;
  let totalNotional = new BN(0),
    totalFee = new BN(0),
    totalCash = new BN(0);
  const makerSide = request.side === "bid" ? "ask" : "bid";
  const crosses = (price: BN) =>
    request.side === "bid"
      ? request.limitPrice.gte(price)
      : request.limitPrice.lte(price);
  function result(stopReason: PredictionMatchStopReason): PredictionMatchPlan {
    return {
      request,
      steps,
      remainingQuantity: remaining,
      totalNotional,
      totalFee,
      totalCash,
      stopReason,
      finalMarket: { ...market },
      finalBook: { ...book },
      finalPosition: { ...taker },
    };
  }
  while (steps.length < MAX_PREDICTION_MATCHES_PER_TRANSACTION) {
    const best = predictionBestPrice(book, request.outcome, makerSide);
    if (!best) return result("book-exhausted");
    if (!crosses(best)) return result("non-crossing");
    const target = await readPredictionMatchTarget(
      overlay,
      request.marketAddress,
      book,
      request.outcome,
      request.side,
      remaining,
    );
    const quote = validatePredictionMatch(
      market,
      book,
      taker,
      target,
      request.outcome,
      request.side,
      request.limitPrice,
      remaining,
      feeBps,
      request.taker,
      now,
    );
    const makerKey = derivePredictionPositionPda(
      request.marketAddress,
      target.maker.owner,
    );
    let maker = positions.get(makerKey.toBase58());
    if (!maker) {
      const stored = await accounts.predictionPosition.fetchNullable(makerKey);
      if (
        !stored ||
        !stored.market.equals(request.marketAddress) ||
        !stored.owner.equals(target.maker.owner)
      )
        throw new Error("Maker position is missing or has invalid ownership");
      maker = { ...stored };
    }
    const free = request.outcome === "yes" ? "yesFree" : "noFree";
    const locked = request.outcome === "yes" ? "yesLocked" : "noLocked";
    const backing =
      makerSide === "bid" ? maker.collateralLocked : maker[locked];
    if (backing.lt(target.maker.lockedCollateral))
      throw new Error("Maker position does not back its order");
    // Use new objects and non-mutating BN operations: previously recorded step
    // targets must keep the pre-fill snapshots used by their instructions.
    if (request.side === "bid") {
      taker = {
        ...taker,
        collateralFree: taker.collateralFree.sub(quote.cash),
        [free]: checkedU64(taker[free].add(quote.fill), "Taker contracts"),
      };
      maker = {
        ...maker,
        collateralFree: checkedU64(
          maker.collateralFree.add(quote.notional),
          "Maker cash",
        ),
        [locked]: maker[locked].sub(quote.fill),
      };
    } else {
      taker = {
        ...taker,
        collateralFree: checkedU64(
          taker.collateralFree.add(quote.cash),
          "Taker cash",
        ),
        [free]: taker[free].sub(quote.fill),
      };
      maker = {
        ...maker,
        collateralLocked: maker.collateralLocked.sub(quote.notional),
        [free]: checkedU64(maker[free].add(quote.fill), "Maker contracts"),
      };
    }
    positions.set(makerKey.toBase58(), maker);
    fees = checkedU64(fees.add(quote.fee), "Accrued fees");
    const full = quote.fill.eq(target.maker.remainingQuantity);
    const remainingAtLevel = checkedU64(
      target.level.totalRemainingQuantity.sub(quote.fill),
      "Level quantity",
    );
    const count = full
      ? checkedU64(target.level.orderCount.subn(1), "Level count")
      : target.level.orderCount;
    if (full)
      market.openOrderCount = checkedU64(
        market.openOrderCount.subn(1),
        "Market count",
      );
    orders.set(target.makerAddress.toBase58(), {
      ...target.maker,
      remainingQuantity: target.maker.remainingQuantity.sub(quote.fill),
      lockedCollateral: target.maker.lockedCollateral.sub(
        makerSide === "bid" ? quote.notional : quote.fill,
      ),
      status: full ? { filled: {} } : target.maker.status,
      nextOrder: full ? null : target.maker.nextOrder,
    });
    if (full && count.isZero()) {
      levels.set(target.levelAddress.toBase58(), null);
      const head =
        request.outcome === "yes"
          ? makerSide === "bid"
            ? "yesBestBid"
            : "yesBestAsk"
          : makerSide === "bid"
            ? "noBestBid"
            : "noBestAsk";
      book[head] = target.level.worsePrice;
      if (target.worseLevel) {
        const worse = await overlay.predictionPriceLevel.fetchNullable(
          target.worseLevel,
        );
        if (!worse) throw new Error("Promoted price level disappeared");
        levels.set(target.worseLevel.toBase58(), {
          ...worse,
          betterPrice: null,
        });
      }
    } else {
      levels.set(target.levelAddress.toBase58(), {
        ...target.level,
        orderCount: count,
        totalRemainingQuantity: remainingAtLevel,
        firstOrder: full ? target.maker.nextOrder : target.level.firstOrder,
      });
      if (target.nextOrder) {
        const next = await overlay.predictionOrder.fetchNullable(
          target.nextOrder,
        );
        if (!next) throw new Error("Promoted FIFO order disappeared");
        orders.set(target.nextOrder.toBase58(), {
          ...next,
          previousOrder: null,
        });
      }
    }
    steps.push({
      target,
      requestedQuantity: remaining,
      fillQuantity: quote.fill,
      notional: quote.notional,
      fee: quote.fee,
    });
    remaining = remaining.sub(quote.fill);
    totalNotional = totalNotional.add(quote.notional);
    // Round each fill first. ceil(a*r)+ceil(b*r) may exceed ceil((a+b)*r).
    totalFee = totalFee.add(quote.fee);
    totalCash = totalCash.add(quote.cash);
    if (remaining.isZero()) return result("filled");
  }
  // Classify the cap boundary without fetching a fourth maker. Posting is safe
  // only when the final opposing head is absent or outside the limit.
  const nextPrice = predictionBestPrice(book, request.outcome, makerSide);
  return result(
    !nextPrice
      ? "book-exhausted"
      : !crosses(nextPrice)
        ? "non-crossing"
        : "match-cap",
  );
}

/** Builds one legacy transaction; all fills and their rent refunds are atomic.
 * Inputs: a freshly built plan and its program. Empty/oversized batches fail
 * before the wallet prompt. A dummy hash measures bytes only; the provider
 * supplies the real recent blockhash and sends normal preflighted execution.
 */
export async function buildPredictionMatchTransaction(
  program: Program,
  plan: PredictionMatchPlan,
  remainder?: TransactionInstruction,
): Promise<Transaction> {
  if (remainder && !canPostPredictionRemainder(plan))
    throw new Error("Unsafe prediction remainder");
  if (plan.steps.length === 0 && !remainder)
    throw new Error("No crossing orders to trade");
  if (plan.steps.length > MAX_PREDICTION_MATCHES_PER_TRANSACTION)
    throw new Error("Too many prediction match steps");
  const { marketAddress, taker, outcome, side, limitPrice } = plan.request;
  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: PREDICTION_MATCH_COMPUTE_UNITS,
    }),
  );
  for (const step of plan.steps) {
    const target = step.target;
    transaction.add(
      await program.methods
        .matchPredictionOrder(
          { [outcome]: {} },
          { [side]: {} },
          limitPrice,
          step.requestedQuantity,
        )
        .accountsStrict({
          taker,
          market: marketAddress,
          orderBook: derivePredictionBookPda(marketAddress),
          protocolConfig: deriveProtocolConfigPda(),
          marketFees: deriveMarketFeesPda(marketAddress),
          makerOrder: target.makerAddress,
          priceLevel: target.levelAddress,
          makerPosition: derivePredictionPositionPda(
            marketAddress,
            target.maker.owner,
          ),
          takerPosition: derivePredictionPositionPda(marketAddress, taker),
          nextOrder: target.nextOrder ?? program.programId,
          worseLevel: target.worseLevel ?? program.programId,
          levelRentRecipient: target.rentRecipient ?? program.programId,
        })
        .instruction(),
    );
  }
  if (remainder) transaction.add(remainder);
  const measured = new Transaction({
    feePayer: taker,
    recentBlockhash: PublicKey.default.toBase58(),
  }).add(...transaction.instructions);
  let bytes: Buffer;
  try {
    bytes = measured.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
  } catch {
    throw new Error(
      "Trade exceeds the transaction packet limit; reduce the quantity or use immediate-only execution",
    );
  }
  if (bytes.length > 1232)
    throw new Error(
      "Trade exceeds the transaction packet limit; reduce the request",
    );
  return transaction;
}
