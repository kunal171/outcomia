/** Build resting placement from the final simulated ledger, never a pre-fill balance. */
import { type Program, type BN } from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  derivePredictionBookPda,
  derivePredictionOrderPda,
  derivePredictionPositionPda,
  derivePredictionPriceLevelPda,
  readPredictionPlacementTarget,
  validatePredictionRestingOrder,
  type PredictionMarketAccount,
  type PredictionOrderBookAccount,
  type PredictionPositionAccount,
  type PredictionPlacementReader,
  type PredictionOutcome,
} from "./prediction";
import { type OrderSide } from "./tidebook";

/** Inputs: fresh own-side accounts and the market/book/position after planned fills.
 * Returns the canonical place/append/insert instruction and its new order PDA.
 * Errors propagate on stale links, insufficient post-fill funds or invalid grids.
 * Matching changes the opposing side only, so own-side neighbors can be read
 * directly. The final opposing head must come from the simulation.
 */
export async function buildPredictionPlacement(
  program: Program,
  reader: PredictionPlacementReader,
  marketAddress: PublicKey,
  owner: PublicKey,
  market: PredictionMarketAccount,
  book: PredictionOrderBookAccount,
  position: PredictionPositionAccount,
  outcome: PredictionOutcome,
  side: OrderSide,
  price: BN,
  quantity: BN,
  now: BN,
) {
  if (
    !book.market.equals(marketAddress) ||
    !position.market.equals(marketAddress) ||
    !position.owner.equals(owner)
  )
    throw new Error("Placement ownership mismatch");
  const target = await readPredictionPlacementTarget(
    reader,
    marketAddress,
    book,
    outcome,
    side,
    price,
  );
  const locked = validatePredictionRestingOrder(
    market,
    book,
    position,
    outcome,
    side,
    price,
    quantity,
    now,
    target.kind === "place" ? undefined : target,
  );
  const order = derivePredictionOrderPda(marketAddress, book.nextOrderId);
  const method =
    target.kind === "append"
      ? program.methods.appendPredictionOrder
      : target.kind === "insert"
        ? program.methods.insertPredictionOrder
        : program.methods.placePredictionOrder;
  const common = {
    owner,
    market: marketAddress,
    position: derivePredictionPositionPda(marketAddress, owner),
    orderBook: derivePredictionBookPda(marketAddress),
    order,
    priceLevel: derivePredictionPriceLevelPda(
      marketAddress,
      outcome,
      side,
      price,
    ),
    systemProgram: SystemProgram.programId,
  };
  const instruction = await method(
    book.nextOrderId,
    { [outcome]: {} },
    { [side]: {} },
    price,
    quantity,
  )
    .accountsStrict(
      target.kind === "append"
        ? { ...common, tailOrder: target.tailAddress }
        : target.kind === "insert"
          ? {
              ...common,
              betterLevel: target.better
                ? derivePredictionPriceLevelPda(
                    marketAddress,
                    outcome,
                    side,
                    target.better.price,
                  )
                : program.programId,
              worseLevel: target.worse
                ? derivePredictionPriceLevelPda(
                    marketAddress,
                    outcome,
                    side,
                    target.worse.price,
                  )
                : program.programId,
            }
          : common,
    )
    .instruction();
  return { instruction, order, locked };
}
