import type { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { getOutcomiaAccounts, deriveMarketMetadataPda } from "./outcomia";
import {
  multiAccounts,
  multiMarketPda,
  multiPositionPda,
  multiBookPda,
  multiOrderPda,
  type MultiMarket,
  type Position,
  type Row,
} from "./multi-outcome";
export interface MultiWalletMarket {
  key: PublicKey;
  market: MultiMarket;
  name: string;
  symbol: string;
  decimals: number;
  position: Position | null;
  orders: Row[];
}
/** Whether any outcome has free or locked contracts; empty positions (for
 * example from finished test markets) are not listed as holdings. */
export const holdsContracts = (r: Pick<MultiWalletMarket, "position">) =>
  !!r.position &&
  [...r.position.free, ...r.position.locked].some((v) => !v.isZero());
/** Owner filters are only RPC hints; canonical identities are verified before displaying claims. */
export async function loadMultiWallet(
  p: Program,
  owner: PublicKey,
  mode: "positions" | "orders",
): Promise<MultiWalletMarket[]> {
  const a = multiAccounts(p);
  const positions =
    mode === "positions"
      ? await a.multiOutcomePosition.all([
          { memcmp: { offset: 40, bytes: owner.toBase58() } },
        ])
      : [];
  const orders =
    mode === "orders"
      ? await a.multiOutcomeOrder.all([
          { memcmp: { offset: 8, bytes: owner.toBase58() } },
        ])
      : [];
  for (const r of positions)
    if (
      !r.account.owner.equals(owner) ||
      !multiPositionPda(r.account.market, owner).equals(r.publicKey)
    )
      throw new Error("Invalid multi-outcome position identity.");
  for (const r of orders)
    if (
      !r.account.owner.equals(owner) ||
      !r.account.book.equals(multiBookPda(r.account.market)) ||
      !multiOrderPda(r.account.book, r.account.orderId).equals(r.publicKey)
    )
      throw new Error("Invalid multi-outcome order identity.");
  const keys = new Map(
    [...positions, ...orders].map((r) => [
      r.account.market.toBase58(),
      r.account.market,
    ]),
  );
  return Promise.all(
    [...keys.values()].map(async (key) => {
      const market = await a.multiOutcomeMarket.fetchNullable(key);
      if (
        !market ||
        !multiMarketPda(Uint8Array.from(market.marketId)).equals(key)
      )
        throw new Error("Multi-outcome market details are unavailable.");
      const metadata = await getOutcomiaAccounts(
        p,
      ).marketMetadata.fetchNullable(deriveMarketMetadataPda(key));
      if (metadata && !metadata.market.equals(key))
        throw new Error("Invalid multi-outcome metadata.");
      if (!/^10*$/.test(market.terms.payoutPerContract.toString()))
        throw new Error("Invalid multi-outcome collateral precision.");
      const own =
        positions.find((r) => r.account.market.equals(key))?.account ?? null;
      return {
        key,
        market,
        name: metadata?.displayName ?? key.toBase58(),
        symbol: metadata?.quoteSymbol ?? "collateral",
        decimals: market.terms.payoutPerContract.toString().length - 1,
        position: own,
        orders: orders.filter((r) => r.account.market.equals(key)),
      };
    }),
  );
}
