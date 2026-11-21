import { indexedAccounts } from "./indexed-accounts";
import { BN, type Program } from "@anchor-lang/core";
import {
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from "@solana/web3.js";
import { provisionalMarketTable } from "./market-lookup-table";
import { PROGRAM_ID } from "./solana";
import {
  COMPLEMENTARY_MATCHING_ENABLED,
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
/** Effective price and size to buy (`side` "bid") or sell ("ask") `outcome`
 * through a full set with every other outcome's best same-side order, or null.
 * Buying takes payout minus the others' best bids; selling, minus their asks.
 * Size is the smallest head remaining. Reads only the book's signed heads. */
export function fullSetQuote(
  m: MultiMarket,
  book: Book,
  outcome: number,
  side: Side,
  rows: Row[],
) {
  const count = m.terms.outcomeLabels.length;
  const byKey = new Map(rows.map((r) => [r.publicKey.toBase58(), r.account]));
  let sum = new BN(0),
    size: BN | null = null;
  for (let j = 0; j < count; j++) {
    if (j === outcome) continue;
    const ref = book.heads[slot(j, side)];
    const order = ref && byKey.get(ref.order.toBase58());
    if (!ref || !order) return null;
    sum = sum.add(ref.price);
    size = size
      ? BN.min(size, order.remainingQuantity)
      : order.remainingQuantity;
  }
  const payout = m.terms.payoutPerContract;
  if (!size || sum.gte(payout)) return null;
  return { price: payout.sub(sum), quantity: size };
}
/** Packs a bounded maker path and safe remainder. Never skips a crossing FIFO order.
 * With complementary matching, the best same-side order of every other outcome
 * also crosses through a full set: buying outcome i at price p fills against
 * other outcomes' bids b_j when p + Σb_j ≥ payout, at an effective p = payout − Σb_j.
 * Each step takes the better of the direct and full-set candidates (direct on
 * ties). A full-set fill that does not fit one legacy packet is skipped for
 * this transaction; no remainder rests while liquidity still crosses. */
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
  complement = COMPLEMENTARY_MATCHING_ENABLED,
  prefix: TransactionInstruction[] = [],
  lookupTable: AddressLookupTableAccount | null = null,
) {
  validateBook(marketKey, book, rows);
  validateOrder(m.terms, outcome, price, quantity);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000)
    throw new Error("Invalid fee quote.");
  const count = m.terms.outcomeLabels.length,
    payout = m.terms.payoutPerContract,
    opposite: Side = side === "bid" ? "ask" : "bid";
  // Local queues per outcome/side, best first, so later steps see filled heads.
  const queues = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.account.outcome[0]}:${sideOf(r.account)}`;
    const list = queues.get(key) ?? [];
    list.push({
      publicKey: r.publicKey,
      account: {
        ...r.account,
        remainingQuantity: r.account.remainingQuantity.clone(),
      },
    });
    queues.set(key, list);
  }
  for (const list of queues.values())
    list.sort((a, b) => priority(a.account, b.account));
  const head = (o: number, sd: Side) => queues.get(`${o}:${sd}`)?.[0] ?? null;
  const consume = (o: number, sd: Side, fill: BN) => {
    const list = queues.get(`${o}:${sd}`)!;
    list[0].account.remainingQuantity =
      list[0].account.remainingQuantity.sub(fill);
    if (list[0].account.remainingQuantity.isZero()) list.shift();
  };
  const crossing = (effective: BN) =>
    side === "bid" ? price.gte(effective) : price.lte(effective);
  let fullSetUsable = complement && count >= 2;
  const fullSet = () => {
    if (!fullSetUsable) return null;
    const heads: Row[] = [];
    for (let j = 0; j < count; j++) {
      if (j === outcome) continue;
      const h = head(j, side);
      if (!h) return null;
      heads.push(h);
    }
    const sum = heads.reduce((a, h) => a.add(h.account.price), new BN(0));
    if (sum.gte(payout)) return null;
    return { heads, effective: payout.sub(sum) };
  };
  const instructions: TransactionInstruction[] = [];
  let remaining = quantity.clone(),
    cost = new BN(0),
    fees = new BN(0),
    blocked = false;
  // Legacy packets first; a v0 transaction with the market's lookup table
  // replaces nine fixed accounts with one-byte indexes when legacy is too big.
  let versioned = false,
    needsLookupTable = false;
  const v0Fits = (
    all: TransactionInstruction[],
    table: AddressLookupTableAccount,
  ) => {
    // Unlike legacy Transaction.serialize, v0 serialization does not reject a
    // transaction above the packet limit, so compare the length explicitly.
    try {
      return (
        new VersionedTransaction(
          new TransactionMessage({
            payerKey: owner,
            recentBlockhash: PublicKey.default.toBase58(),
            instructions: all,
          }).compileToV0Message([table]),
        ).serialize().length <= 1232
      );
    } catch {
      return false;
    }
  };
  const fits = (ix: TransactionInstruction) => {
    const all = [...prefix, ...instructions, ix];
    if (!versioned)
      try {
        transactionBytes(new Transaction().add(...all), owner);
        return true;
      } catch {
        /* Try a v0 transaction below. */
      }
    if (lookupTable && v0Fits(all, lookupTable)) {
      versioned = true;
      return true;
    }
    if (
      !lookupTable &&
      v0Fits(all, provisionalMarketTable(marketKey, m.collateralMint))
    )
      needsLookupTable = true;
    return false;
  };
  while (remaining.gtn(0)) {
    const direct = head(outcome, opposite);
    const set = fullSet();
    const directOk = !!direct && crossing(direct.account.price);
    const setOk = !!set && crossing(set.effective);
    if (!directOk && !setOk) break;
    if (instructions.length === 3) {
      blocked = true;
      break;
    }
    const useSet =
      setOk &&
      (!directOk ||
        (side === "bid"
          ? set!.effective.lt(direct!.account.price)
          : set!.effective.gt(direct!.account.price)));
    if (useSet) {
      const s = set!;
      if (s.heads.some((h) => h.account.owner.equals(owner)))
        throw new Error(
          "Your own order heads another outcome's queue. Cancel it first.",
        );
      const smallest = s.heads.reduce(
        (a, h) => BN.min(a, h.account.remainingQuantity),
        s.heads[0].account.remainingQuantity,
      );
      const buildSet = (requested: BN) => {
        const filled = BN.min(requested, smallest);
        const remainingAccounts = s.heads.flatMap((h) => {
          const next =
            h.account.remainingQuantity.eq(filled) && h.account.next
              ? h.account.next
              : PROGRAM_ID;
          return [
            { pubkey: h.publicKey, isSigner: false, isWritable: true },
            {
              pubkey: next,
              isSigner: false,
              isWritable: !next.equals(PROGRAM_ID),
            },
            {
              pubkey: assetBalancePda(h.account.owner, m.collateralMint),
              isSigner: false,
              isWritable: true,
            },
            {
              pubkey: multiPositionPda(marketKey, h.account.owner),
              isSigner: false,
              isWritable: true,
            },
          ];
        });
        return p.methods
          .matchMultiOutcomeComplement(
            [outcome],
            enumSide(side),
            price,
            requested,
            feeBps,
          )
          .accountsStrict({
            taker: owner,
            market: marketKey,
            book: multiBookPda(marketKey),
            protocolConfig: deriveProtocolConfigPda(),
            takerCash: assetBalancePda(owner, m.collateralMint),
            takerPosition: multiPositionPda(marketKey, owner),
            mint: m.collateralMint,
            assetAuthority: assetAuthorityPda(m.collateralMint),
            assetVault: assetVaultPda(m.collateralMint),
            marketAuthority: deriveVaultAuthorityPda(marketKey),
            marketVault: deriveVaultPda(marketKey, m.collateralMint),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(remainingAccounts)
          .instruction();
      };
      let fill = BN.min(remaining, smallest);
      let ix = await buildSet(remaining);
      if (!fits(ix)) {
        // Completed heads add successor accounts. Filling one lot less than
        // the smallest head completes none, which keeps the packet smallest.
        const lot = m.terms.quantityLot;
        const reduced = smallest.sub(lot);
        if (fill.eq(smallest) && reduced.gtn(0)) {
          fill = reduced;
          ix = await buildSet(reduced);
        }
        if (!fill.lt(smallest) || !fits(ix)) {
          // Too large even so: use direct liquidity for this transaction.
          fullSetUsable = false;
          continue;
        }
      }
      instructions.push(ix);
      const notional = s.effective.mul(fill);
      cost = cost.add(notional);
      fees = fees.add(notional.muln(feeBps).addn(9999).divn(10000));
      for (const h of s.heads) consume(h.account.outcome[0], side, fill);
      remaining = remaining.sub(fill);
      continue;
    }
    const o = direct!.account;
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
        makerOrder: direct!.publicKey,
        makerCash: assetBalancePda(o.owner, m.collateralMint),
        makerPosition: multiPositionPda(marketKey, o.owner),
        takerCash: assetBalancePda(owner, m.collateralMint),
        takerPosition: multiPositionPda(marketKey, owner),
        next: o.next ?? PROGRAM_ID,
      })
      .instruction();
    if (!fits(ix)) {
      if (!instructions.length)
        throw new Error("One match exceeds the packet limit.");
      blocked = true;
      break;
    }
    instructions.push(ix);
    remaining = remaining.sub(fill);
    cost = cost.add(notional);
    fees = fees.add(fee);
    consume(outcome, opposite, fill);
  }
  // Crossing liquidity of either kind forbids a resting remainder; the program
  // rejects crossed placements. A skipped full set still counts as crossing.
  const directCross = (() => {
    const d = head(outcome, opposite);
    return !!d && crossing(d.account.price);
  })();
  const setCross = (() => {
    const saved = fullSetUsable;
    fullSetUsable = complement && count >= 2;
    const s = fullSet();
    fullSetUsable = saved;
    return !!s && crossing(s.effective);
  })();
  if (remaining.gtn(0) && (directCross || setCross)) blocked = true;
  if (remaining.gtn(0) && !blocked) {
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
    if (fits(ix)) instructions.push(ix);
    else blocked = true;
  }
  if (!instructions.length && remaining.gtn(0) && blocked)
    throw new Error(
      needsLookupTable
        ? "Filling at this price needs this market's lookup table. Enable large full-set fills, then retry."
        : setCross
          ? "Filling at this price needs every other outcome's best order in one transaction, which exceeds the packet limit. Use a price below the full-set price to rest an order."
          : "These matches exceed the packet limit. Submit a smaller quantity.",
    );
  return {
    transaction: new Transaction().add(...instructions),
    remaining: blocked ? remaining : new BN(0),
    cost,
    fees,
    /** Send as a v0 transaction with this table when set. */
    lookupTable: versioned ? lookupTable : null,
    /** A full set would fit with the market's lookup table, which is missing. */
    needsLookupTable,
  };
}
