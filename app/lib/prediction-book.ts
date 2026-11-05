/** Read a bounded public depth snapshot by following canonical price links. */
import { BN } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import {
  derivePredictionPriceLevelPda,
  predictionBestPrice,
  type PredictionOrderBookAccount,
  type PredictionOutcome,
  type PredictionPriceLevelAccount,
} from "./prediction";
import { type OrderSide } from "./tidebook";

export const PREDICTION_DEPTH_LIMIT = 20;
export interface PredictionDepth {
  levels: PredictionPriceLevelAccount[];
  hasMore: boolean;
}

/** Inputs: book root, selected outcome/side and its account reader.
 * Returns up to 20 aggregated levels, best first, with an explicit depth limit.
 * Errors: missing accounts, RPC failure, invalid identity, totals or links.
 * Reads are not a single-slot snapshot: a concurrent splice asks the UI to
 * refresh rather than presenting an incomplete read as an empty book.
 */
export async function readPredictionDepth(
  reader: {
    fetchNullable(
      address: PublicKey,
    ): Promise<PredictionPriceLevelAccount | null>;
  },
  market: PublicKey,
  book: PredictionOrderBookAccount,
  outcome: PredictionOutcome,
  side: OrderSide,
): Promise<PredictionDepth> {
  if (!book.market.equals(market)) throw new Error("Book ownership mismatch");
  const levels: PredictionPriceLevelAccount[] = [];
  let price = predictionBestPrice(book, outcome, side);
  let previous: BN | null = null;
  while (price && levels.length < PREDICTION_DEPTH_LIMIT) {
    const value = await reader.fetchNullable(
      derivePredictionPriceLevelPda(market, outcome, side, price),
    );
    if (
      !value ||
      !value.market.equals(market) ||
      !(outcome in value.outcome) ||
      !(side in value.side) ||
      !value.price.eq(price) ||
      price.lten(0) ||
      value.orderCount.lten(0) ||
      value.totalRemainingQuantity.lten(0) ||
      !value.firstOrder ||
      !value.lastOrder ||
      (previous
        ? !value.betterPrice?.eq(previous)
        : value.betterPrice !== null) ||
      (value.worsePrice &&
        (side === "bid"
          ? value.worsePrice.gte(price)
          : value.worsePrice.lte(price)))
    )
      throw new Error(
        "Order book changed or contains invalid links; refresh depth",
      );
    levels.push(value);
    previous = price;
    price = value.worsePrice;
  }
  return { levels, hasMore: price !== null };
}
