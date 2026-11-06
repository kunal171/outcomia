/** Shared custody uses mint/owner PDAs; orders and YES/NO remain tied to one book.
 * Keep this rollout disabled until the program and generated IDL are deployed together. */
import { BN, type Program } from "@anchor-lang/core";
import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  type Transaction,
} from "@solana/web3.js";
import { PROGRAM_ID } from "./solana";
import { deriveProtocolConfigPda } from "./tidebook";
import { derivePredictionPositionPda } from "./prediction";
export const SHARED_BALANCES_ENABLED =
  process.env.NEXT_PUBLIC_SHARED_BALANCES_ENABLED === "true";
export const PREDICTION_RESOLUTION_ENABLED =
  SHARED_BALANCES_ENABLED &&
  process.env.NEXT_PUBLIC_PREDICTION_RESOLUTION_ENABLED === "true";
export type Outcome = "spot" | "yes" | "no";
export type Side = "bid" | "ask";
export interface AssetBalance {
  owner: PublicKey;
  mint: PublicKey;
  free: BN;
  locked: BN;
  bump: number;
}
export interface SharedBook {
  market: PublicKey;
  authority: PublicKey;
  kind: { spot?: object; prediction?: object };
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  priceTick: BN;
  quantityLot: BN;
  payoutPerContract: BN;
  bestPrices: (BN | null)[];
  nextOrderId: BN;
  openOrderCount: BN;
  accruedQuoteFees: BN;
}
export interface SharedOrder {
  owner: PublicKey;
  market: PublicKey;
  book: PublicKey;
  orderId: BN;
  outcome: Record<Outcome, object>;
  side: Record<Side, object>;
  price: BN;
  priceLevel: PublicKey;
  previousOrder: PublicKey | null;
  nextOrder: PublicKey | null;
  quantity: BN;
  remainingQuantity: BN;
  lockedCollateral: BN;
  status: { open?: object; filled?: object; canceled?: object };
}
export interface SharedLevel {
  book: PublicKey;
  market: PublicKey;
  outcome: Record<Outcome, object>;
  side: Record<Side, object>;
  price: BN;
  betterPrice: BN | null;
  worsePrice: BN | null;
  firstOrder: PublicKey | null;
  lastOrder: PublicKey | null;
  orderCount: BN;
  totalRemainingQuantity: BN;
  rentPayer: PublicKey;
}
interface Reader<T> {
  fetchNullable(key: PublicKey): Promise<T | null>;
  all(
    filters?: { memcmp: { offset: number; bytes: string } }[],
  ): Promise<{ publicKey: PublicKey; account: T }[]>;
}
export function sharedAccounts(p: Program) {
  return p.account as unknown as {
    assetBalance: Reader<AssetBalance>;
    sharedBook: Reader<SharedBook>;
    sharedOrder: Reader<SharedOrder>;
    sharedPriceLevel: Reader<SharedLevel>;
  };
}
function address(seed: string, ...parts: Uint8Array[]) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...parts.map((p) => Buffer.from(p))],
    PROGRAM_ID,
  )[0];
}
export const assetBalancePda = (owner: PublicKey, mint: PublicKey) =>
  address("asset_balance", owner.toBytes(), mint.toBytes());
export const assetVaultPda = (mint: PublicKey) =>
  address("asset_vault", mint.toBytes());
export const assetAuthorityPda = (mint: PublicKey) =>
  address("asset_authority", mint.toBytes());
export const sharedBookPda = (market: PublicKey) =>
  address("shared_book", market.toBytes());
export const sharedOrderPda = (book: PublicKey, id: BN) =>
  address("shared_order", book.toBytes(), id.toArrayLike(Buffer, "le", 8));
export const sharedLevelPda = (
  book: PublicKey,
  outcome: Outcome,
  side: Side,
  price: BN,
) =>
  address(
    "shared_level",
    book.toBytes(),
    Buffer.from(outcome),
    Buffer.from(side),
    price.toArrayLike(Buffer, "le", 8),
  );
export function traderAccounts(book: SharedBook, owner: PublicKey) {
  return {
    baseBalance:
      "spot" in book.kind ? assetBalancePda(owner, book.baseMint) : null,
    quoteBalance: assetBalancePda(owner, book.quoteMint),
    position:
      "prediction" in book.kind
        ? derivePredictionPositionPda(book.market, owner)
        : null,
  };
}
/** Anchor encodes an omitted optional account as the program ID sentinel. */
function optionalAccounts(
  values: Record<string, PublicKey | null>,
): Record<string, PublicKey> {
  return Object.fromEntries(
    Object.entries(values).map(([name, key]) => [name, key ?? PROGRAM_ID]),
  );
}
export const variant = (value: string) => ({ [value]: {} });
export function assetCustody(owner: PublicKey, mint: PublicKey) {
  return {
    owner,
    mint,
    assetBalance: assetBalancePda(owner, mint),
    vaultAuthority: assetAuthorityPda(mint),
    assetVault: assetVaultPda(mint),
  };
}
/** Fetch one coherent queue snapshot. Stale links fail on chain; never skip a FIFO maker. */
export async function readSharedBook(p: Program, market: PublicKey) {
  const a = sharedAccounts(p),
    key = sharedBookPda(market);
  const book = await a.sharedBook.fetchNullable(key);
  if (!book) return null;
  if (!book.market.equals(market))
    throw new Error("Shared book market mismatch");
  const [orders, levels] = await Promise.all([
    a.sharedOrder.all([{ memcmp: { offset: 72, bytes: key.toBase58() } }]),
    a.sharedPriceLevel.all([{ memcmp: { offset: 8, bytes: key.toBase58() } }]),
  ]);
  for (const r of orders)
    if (
      !r.account.book.equals(key) ||
      !r.account.market.equals(market) ||
      !sharedOrderPda(key, r.account.orderId).equals(r.publicKey)
    )
      throw new Error("Invalid shared order");
  for (const r of levels)
    if (!r.account.book.equals(key) || !r.account.market.equals(market))
      throw new Error("Invalid shared level");
  return { key, book, orders, levels };
}
export type SharedSnapshot = NonNullable<
  Awaited<ReturnType<typeof readSharedBook>>
>;
/** Owner cancellation includes only exact queue neighbors. Lifecycle never gates an exit. */
export async function cancelShared(
  p: Program,
  s: SharedSnapshot,
  owner: PublicKey,
  key: PublicKey,
) {
  const row = s.orders.find((r) => r.publicKey.equals(key));
  if (!row || !row.account.owner.equals(owner))
    throw new Error("Order owner mismatch");
  const o = row.account,
    l = s.levels.find((r) => r.publicKey.equals(o.priceLevel))?.account;
  if (!l) throw new Error("Level missing; refresh");
  const outcome = Object.keys(o.outcome)[0] as Outcome,
    side = Object.keys(o.side)[0] as Side;
  const last = l.orderCount.eqn(1);
  return p.methods
    .cancelSharedOrder()
    .accountsPartial(
      optionalAccounts({
        owner,
        book: s.key,
        ...traderAccounts(s.book, owner),
        order: key,
        priceLevel: o.priceLevel,
        previousOrder: o.previousOrder,
        nextOrder: o.nextOrder,
        betterLevel:
          last && l.betterPrice
            ? sharedLevelPda(s.key, outcome, side, l.betterPrice)
            : null,
        worseLevel:
          last && l.worsePrice
            ? sharedLevelPda(s.key, outcome, side, l.worsePrice)
            : null,
        levelRentRecipient: last ? l.rentPayer : null,
      }),
    )
    .instruction();
}
/** Plans at most three makers atomically, then posts only a noncrossing remainder.
 * Local copies model removed heads so later instructions use the repaired FIFO.
 * The program rechecks every price, link, balance and cutoff during execution. */
export async function buildSharedTrade(
  p: Program,
  s: SharedSnapshot,
  owner: PublicKey,
  outcome: Outcome,
  side: Side,
  price: BN,
  quantity: BN,
) {
  if (
    price.lten(0) ||
    quantity.lten(0) ||
    price.bitLength() > 64 ||
    quantity.bitLength() > 64
  )
    throw new Error("Enter positive price and quantity");
  if (
    !price.mod(s.book.priceTick).isZero() ||
    !quantity.mod(s.book.quantityLot).isZero()
  )
    throw new Error("Price or quantity is outside the market increments");
  const prediction = "prediction" in s.book.kind;
  if (prediction ? outcome !== "yes" && outcome !== "no" : outcome !== "spot")
    throw new Error("Outcome does not belong to this market type");
  if (prediction && price.gte(s.book.payoutPerContract))
    throw new Error("Contract price must be below its winning payout");
  const notional = price
    .mul(quantity)
    .div(new BN(10).pow(new BN(s.book.baseDecimals)));
  if (notional.isZero() || notional.bitLength() > 64)
    throw new Error("Order value is zero or exceeds u64");
  const opposite: Side = side === "bid" ? "ask" : "bid";
  const orders = s.orders
    .filter((r) => "open" in r.account.status)
    .map((r) => ({ publicKey: r.publicKey, account: { ...r.account } }));
  const levels = s.levels.map((r) => ({
    publicKey: r.publicKey,
    account: { ...r.account },
  }));
  let remaining = quantity.clone(),
    fills = 0;
  const instructions: TransactionInstruction[] = [];
  const crossing = (v: BN) => (side === "bid" ? price.gte(v) : price.lte(v));
  while (remaining.gtn(0) && fills < 3) {
    const candidates = levels
      .filter(
        (r) =>
          outcome in r.account.outcome &&
          opposite in r.account.side &&
          r.account.orderCount.gtn(0),
      )
      .sort((a, b) =>
        opposite === "ask"
          ? a.account.price.cmp(b.account.price)
          : b.account.price.cmp(a.account.price),
      );
    const l = candidates[0];
    if (!l || !crossing(l.account.price)) break;
    const maker = orders.find((r) => r.publicKey.equals(l.account.firstOrder!));
    if (!maker) throw new Error("FIFO head missing; refresh");
    if (maker.account.owner.equals(owner))
      throw new Error(
        "Your order is first in this queue. Cancel it before trading against this price.",
      );
    const fill = BN.min(remaining, maker.account.remainingQuantity),
      full = fill.eq(maker.account.remainingQuantity),
      last = full && l.account.orderCount.eqn(1);
    const m = traderAccounts(s.book, maker.account.owner),
      t = traderAccounts(s.book, owner);
    instructions.push(
      await p.methods
        .matchSharedOrder(variant(outcome), variant(side), price, remaining)
        .accountsPartial(
          optionalAccounts({
            taker: owner,
            market: s.book.market,
            book: s.key,
            protocolConfig: deriveProtocolConfigPda(),
            makerOrder: maker.publicKey,
            priceLevel: l.publicKey,
            makerBase: m.baseBalance,
            makerQuote: m.quoteBalance,
            makerPosition: m.position,
            takerBase: t.baseBalance,
            takerQuote: t.quoteBalance,
            takerPosition: t.position,
            nextOrder: full ? maker.account.nextOrder : null,
            worseLevel:
              last && l.account.worsePrice
                ? sharedLevelPda(s.key, outcome, opposite, l.account.worsePrice)
                : null,
            levelRentRecipient: last ? l.account.rentPayer : null,
          }),
        )
        .instruction(),
    );
    remaining = remaining.sub(fill);
    fills++;
    maker.account.remainingQuantity = maker.account.remainingQuantity.sub(fill);
    if (full) {
      l.account.orderCount = l.account.orderCount.subn(1);
      l.account.firstOrder = maker.account.nextOrder;
      const next = orders.find((r) =>
        maker.account.nextOrder?.equals(r.publicKey),
      );
      if (next) next.account.previousOrder = null;
    }
    if (last) {
      const next = levels.find(
        (r) =>
          l.account.worsePrice?.eq(r.account.price) &&
          outcome in r.account.outcome &&
          opposite in r.account.side,
      );
      if (next) next.account.betterPrice = null;
    }
  }
  const blocked = levels.some(
    (r) =>
      outcome in r.account.outcome &&
      opposite in r.account.side &&
      r.account.orderCount.gtn(0) &&
      crossing(r.account.price),
  );
  // A sub-atom-value remainder cannot rest. Keep it free rather than rolling
  // back valid earlier fills with a zero-notional placement instruction.
  const dust =
    remaining.gtn(0) &&
    price
      .mul(remaining)
      .div(new BN(10).pow(new BN(s.book.baseDecimals)))
      .isZero();
  if (remaining.gtn(0) && !blocked && !dust) {
    const same = levels.filter(
      (r) =>
        outcome in r.account.outcome &&
        side in r.account.side &&
        r.account.orderCount.gtn(0),
    );
    const existing = same.find((r) => r.account.price.eq(price));
    const sorted = [...same.map((r) => r.account.price), price].sort((a, b) =>
        side === "bid" ? b.cmp(a) : a.cmp(b),
      ),
      at = sorted.findIndex((v) => v.eq(price));
    instructions.push(
      await p.methods
        .placeSharedOrder(
          variant(outcome),
          variant(side),
          price,
          remaining,
          s.book.nextOrderId,
        )
        .accountsPartial(
          optionalAccounts({
            owner,
            market: s.book.market,
            book: s.key,
            ...traderAccounts(s.book, owner),
            order: sharedOrderPda(s.key, s.book.nextOrderId),
            priceLevel: sharedLevelPda(s.key, outcome, side, price),
            tail: existing?.account.lastOrder ?? null,
            betterLevel:
              !existing && at > 0
                ? sharedLevelPda(s.key, outcome, side, sorted[at - 1])
                : null,
            worseLevel:
              !existing && at < sorted.length - 1
                ? sharedLevelPda(s.key, outcome, side, sorted[at + 1])
                : null,
            systemProgram: SystemProgram.programId,
          }),
        )
        .instruction(),
    );
  }
  return {
    instructions,
    remaining: blocked || dust ? remaining : new BN(0),
    fills,
    stopReason: blocked ? "maker-limit" : dust ? "zero-notional" : null,
  };
}

/** Reject oversized legacy packets before asking the wallet to sign.
 * The placeholder blockhash has the same encoded size as the real recent blockhash. */
export function assertSharedTransactionFits(tx: Transaction, owner: PublicKey) {
  tx.feePayer = owner;
  tx.recentBlockhash = PublicKey.default.toBase58();
  try {
    tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  } catch {
    throw new Error(
      "This batch exceeds the transaction packet limit. Initialize the asset balances first, or submit a smaller quantity to match fewer makers.",
    );
  }
}
