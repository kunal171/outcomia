import { indexedAccounts } from "./indexer-client";
import { BN, type Program } from "@anchor-lang/core";
import { PublicKey, Transaction } from "@solana/web3.js";
import { PROGRAM_ID } from "./solana";
import {
  SHARED_BALANCES_ENABLED,
  assetBalancePda,
  assetVaultPda,
  assetAuthorityPda,
} from "./shared";
import {
  TOKEN_PROGRAM_ID,
  deriveVaultAuthorityPda,
  deriveVaultPda,
  deriveProtocolConfigPda,
} from "./outcomia";
export const MULTI_OUTCOME_ENABLED =
  SHARED_BALANCES_ENABLED &&
  process.env.NEXT_PUBLIC_MULTI_OUTCOME_ENABLED === "true";
export type Side = "bid" | "ask";
export type Resolution = { winner?: [[number]]; invalid?: object };
export interface Terms {
  resolver: PublicKey;
  fallback: {
    resolver: PublicKey;
    availableTs: BN;
    deadlineTs: BN | null;
  } | null;
  outcomeLabels: string[];
  questionHash: number[];
  rulesHash: number[];
  rulesUri: string;
  closeTs: BN;
  earliestResolutionTs: BN | null;
  resolutionDelaySeconds: BN;
  payoutPerContract: BN;
  priceTick: BN;
  quantityLot: BN;
}
export interface MultiMarket {
  marketId: number[];
  authority: PublicKey;
  terms: Terms;
  collateralMint: PublicKey;
  collateralVault: PublicKey;
  metadata: PublicKey;
  status: {
    draft?: object;
    open?: object;
    frozen?: object;
    proposed?: object;
    resolved?: object;
  };
  resolutionPhase: { primary?: object; fallback?: object };
  proposal: {
    outcome: Resolution;
    proposedAt: BN;
    evidenceUri: string;
    evidenceHash: number[];
  } | null;
  finalOutcome: Resolution | null;
  supplies: BN[];
  backingReserve: BN;
  openOrderCount: BN;
}
export interface Position {
  market: PublicKey;
  owner: PublicKey;
  free: BN[];
  locked: BN[];
}
export interface Order {
  market: PublicKey;
  book: PublicKey;
  owner: PublicKey;
  orderId: BN;
  outcome: [number];
  side: { bid?: object; ask?: object };
  price: BN;
  quantity: BN;
  remainingQuantity: BN;
  lockedAmount: BN;
  previous: PublicKey | null;
  next: PublicKey | null;
  status: { open?: object; filled?: object; canceled?: object };
}
export interface Reference {
  order: PublicKey;
  orderId: BN;
  outcome: [number];
  side: Order["side"];
  price: BN;
}
export interface Book {
  market: PublicKey;
  authority: PublicKey;
  heads: (Reference | null)[];
  openOrderCount: BN;
  nextOrderId: BN;
  accruedCollateralFees: BN;
}
interface Reader<T> {
  fetchNullable(key: PublicKey): Promise<T | null>;
  all(
    filters?: { memcmp: { offset: number; bytes: string } }[],
  ): Promise<{ publicKey: PublicKey; account: T }[]>;
}
export const multiAccounts = (p: Program) =>
  indexedAccounts(p) as unknown as {
    multiOutcomeTermsBuffer: Reader<{
      authority: PublicKey;
      marketId: number[];
    }>;
    multiOutcomeMarket: Reader<MultiMarket>;
    multiOutcomePosition: Reader<Position>;
    multiOutcomeBook: Reader<Book>;
    multiOutcomeOrder: Reader<Order>;
  };
const pda = (seed: string, ...keys: Uint8Array[]) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys], PROGRAM_ID)[0];
export const multiMarketPda = (id: Uint8Array) => pda("multi_market", id);
export const multiPositionPda = (market: PublicKey, owner: PublicKey) =>
  pda("multi_position", market.toBytes(), owner.toBytes());
export const multiBookPda = (market: PublicKey) =>
  pda("multi_book", market.toBytes());
export const multiOrderPda = (book: PublicKey, id: BN) =>
  pda("multi_order", book.toBytes(), id.toArrayLike(Buffer, "le", 8));
export const sideOf = (o: Pick<Order, "side">): Side =>
  "bid" in o.side ? "bid" : "ask";
export const statusOf = (m: MultiMarket) => Object.keys(m.status)[0];
export const slot = (outcome: number, side: Side) =>
  outcome * 2 + (side === "ask" ? 1 : 0);
export const enumSide = (side: Side) => ({ [side]: {} });
export function whole(value: string) {
  if (!/^[0-9]+$/.test(value))
    throw new Error("Enter a whole contract quantity.");
  const n = new BN(value);
  if (n.isZero() || n.bitLength() > 64)
    throw new Error("Quantity must be positive and fit in u64.");
  return n;
}
export function validateOrder(
  t: Terms,
  outcome: number,
  price: BN,
  quantity: BN,
) {
  if (
    !Number.isInteger(outcome) ||
    outcome < 0 ||
    outcome >= t.outcomeLabels.length
  )
    throw new Error("Choose a valid outcome.");
  if (
    price.lten(0) ||
    price.gte(t.payoutPerContract) ||
    !price.mod(t.priceTick).isZero()
  )
    throw new Error(
      "Price must be below face value and follow the price tick.",
    );
  if (
    quantity.lten(0) ||
    !quantity.mod(t.quantityLot).isZero() ||
    quantity.bitLength() > 64 ||
    price.mul(quantity).bitLength() > 64
  )
    throw new Error(
      "Quantity must follow the market lot and collateral limits.",
    );
}
export function custody(market: PublicKey, owner: PublicKey, mint: PublicKey) {
  return {
    owner,
    market,
    position: multiPositionPda(market, owner),
    mint,
    assetBalance: assetBalancePda(owner, mint),
    assetAuthority: assetAuthorityPda(mint),
    assetVault: assetVaultPda(mint),
    marketAuthority: deriveVaultAuthorityPda(market),
    marketVault: deriveVaultPda(market, mint),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}
export type Row = { publicKey: PublicKey; account: Order };
export function priority(
  a: Pick<Order, "price" | "orderId" | "side">,
  b: Pick<Order, "price" | "orderId" | "side">,
) {
  return a.price.eq(b.price)
    ? a.orderId.cmp(b.orderId)
    : sideOf(a) === "bid"
      ? b.price.cmp(a.price)
      : a.price.cmp(b.price);
}
/** Rebuild every root, failing on missing nodes, cycles, foreign orders or broken FIFO. */
export function validateBook(market: PublicKey, book: Book, rows: Row[]) {
  const key = multiBookPda(market),
    seen = new Set<string>();
  if (!book.market.equals(market) || book.heads.length !== 16)
    throw new Error("Invalid multi-outcome book.");
  const byKey = new Map(rows.map((r) => [r.publicKey.toBase58(), r]));
  for (let i = 0; i < 16; i++) {
    let ref = book.heads[i],
      previous: Row | null = null;
    while (ref) {
      const id = ref.order.toBase58(),
        row = byKey.get(id);
      if (seen.has(id) || !row)
        throw new Error("Book is incomplete or contains a cycle. Refresh.");
      const o = row.account;
      if (
        !o.market.equals(market) ||
        !o.book.equals(key) ||
        !multiOrderPda(key, o.orderId).equals(row.publicKey) ||
        !("open" in o.status) ||
        slot(o.outcome[0], sideOf(o)) !== i ||
        !o.orderId.eq(ref.orderId) ||
        !o.price.eq(ref.price) ||
        o.outcome[0] !== ref.outcome[0] ||
        sideOf(o) !== sideOf(ref) ||
        o.remainingQuantity.lten(0) ||
        o.remainingQuantity.gt(o.quantity) ||
        o.orderId.gte(book.nextOrderId)
      )
        throw new Error("Invalid order identity or queue.");
      if (
        (o.previous?.toBase58() ?? null) !==
        (previous?.publicKey.toBase58() ?? null)
      )
        throw new Error("Broken reciprocal book link.");
      if (previous && priority(previous.account, o) >= 0)
        throw new Error("Invalid price/FIFO ordering.");
      seen.add(id);
      previous = row;
      if (o.next) {
        const n = byKey.get(o.next.toBase58());
        if (!n) throw new Error("Book is incomplete. Refresh.");
        ref = { order: n.publicKey, ...n.account };
      } else ref = null;
    }
  }
  if (!book.openOrderCount.eqn(seen.size) || rows.length !== seen.size)
    throw new Error("Book count does not match open orders.");
}
export function neighbors(
  rows: Row[],
  outcome: number,
  side: Side,
  price: BN,
  orderId: BN,
) {
  const same = rows
    .filter(
      (r) => r.account.outcome[0] === outcome && sideOf(r.account) === side,
    )
    .sort((a, b) => priority(a.account, b.account));
  const at = same.findIndex(
      (r) => priority({ price, orderId, side: enumSide(side) }, r.account) < 0,
    ),
    index = at < 0 ? same.length : at;
  return {
    previous: same[index - 1]?.publicKey ?? PROGRAM_ID,
    next: same[index]?.publicKey ?? PROGRAM_ID,
  };
}
/** Includes signature slots. The placeholder blockhash has the real encoded length. */
export function transactionBytes(tx: Transaction, owner: PublicKey) {
  const copy = new Transaction({
    feePayer: owner,
    recentBlockhash: PublicKey.default.toBase58(),
  }).add(...tx.instructions);
  try {
    return copy.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).length;
  } catch {
    throw new Error(
      "Transaction exceeds 1,232 bytes. Shorten labels/rules URI or submit fewer matches.",
    );
  }
}
export async function readMultiBook(p: Program, market: PublicKey) {
  const a = multiAccounts(p),
    book = await a.multiOutcomeBook.fetchNullable(multiBookPda(market));
  if (!book) return null;
  const rows = (
    await a.multiOutcomeOrder.all([
      { memcmp: { offset: 40, bytes: market.toBase58() } },
    ])
  ).filter((r) => "open" in r.account.status);
  validateBook(market, book, rows);
  return { book, rows };
}
/** Packs a bounded maker path and safe remainder. Never skips a crossing FIFO order. */
export async function buildMultiTrade(
  p: Program,
  marketKey: PublicKey,
  m: MultiMarket,
  book: Book,
  rows: Row[],
  owner: PublicKey,
  outcome: number,
  side: Side,
  price: BN,
  quantity: BN,
  feeBps: number,
) {
  validateBook(marketKey, book, rows);
  validateOrder(m.terms, outcome, price, quantity);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000)
    throw new Error("Invalid fee quote.");
  const opposite = rows
    .filter(
      (r) => r.account.outcome[0] === outcome && sideOf(r.account) !== side,
    )
    .sort((a, b) => priority(a.account, b.account));
  const tx = new Transaction();
  let remaining = quantity.clone(),
    cost = new BN(0),
    fees = new BN(0),
    blocked = false;
  for (const maker of opposite) {
    const o = maker.account;
    if (side === "bid" ? price.lt(o.price) : price.gt(o.price)) break;
    if (tx.instructions.length === 3) {
      blocked = true;
      break;
    }
    if (o.owner.equals(owner))
      throw new Error(
        "Your own order is next in FIFO priority. Cancel it first.",
      );
    const fill = BN.min(remaining, o.remainingQuantity),
      notional = o.price.mul(fill),
      fee = notional.muln(feeBps).addn(9999).divn(10000);
    const ix = await p.methods
      .matchMultiOutcomeOrder([outcome], enumSide(side), price, fill, feeBps)
      .accountsStrict({
        taker: owner,
        market: marketKey,
        book: multiBookPda(marketKey),
        protocolConfig: deriveProtocolConfigPda(),
        makerOrder: maker.publicKey,
        makerCash: assetBalancePda(o.owner, m.collateralMint),
        makerPosition: multiPositionPda(marketKey, o.owner),
        takerCash: assetBalancePda(owner, m.collateralMint),
        takerPosition: multiPositionPda(marketKey, owner),
        next: o.next ?? PROGRAM_ID,
      })
      .instruction();
    try {
      transactionBytes(new Transaction().add(...tx.instructions, ix), owner);
    } catch {
      if (!tx.instructions.length)
        throw new Error("One match exceeds the packet limit.");
      blocked = true;
      break;
    }
    tx.add(ix);
    remaining = remaining.sub(fill);
    cost = cost.add(notional);
    fees = fees.add(fee);
    if (remaining.isZero()) break;
  }
  if (!remaining.isZero() && !blocked) {
    const ix = await p.methods
      .placeMultiOutcomeOrder(
        [outcome],
        enumSide(side),
        price,
        remaining,
        book.nextOrderId,
      )
      .accountsStrict({
        owner,
        market: marketKey,
        book: multiBookPda(marketKey),
        cash: assetBalancePda(owner, m.collateralMint),
        position: multiPositionPda(marketKey, owner),
        order: multiOrderPda(multiBookPda(marketKey), book.nextOrderId),
        systemProgram: PublicKey.default,
        ...neighbors(rows, outcome, side, price, book.nextOrderId),
      })
      .instruction();
    try {
      transactionBytes(new Transaction().add(...tx.instructions, ix), owner);
      tx.add(ix);
    } catch {
      if (!tx.instructions.length)
        throw new Error("Placement exceeds the packet limit.");
      blocked = true;
    }
  }
  return {
    transaction: tx,
    remaining: blocked ? remaining : new BN(0),
    cost,
    fees,
  };
}
