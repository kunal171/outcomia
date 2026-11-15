import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { loadTypeScript } from "./support/typescript.mjs";
const require = createRequire(import.meta.url);
const { BN, Program } = require("@anchor-lang/core");
const { PublicKey, Transaction } = require("@solana/web3.js");
const m = loadTypeScript(new URL("../lib/multi-outcome.ts", import.meta.url));
const creation = loadTypeScript(
  new URL("../lib/multi-outcome-creation.ts", import.meta.url),
);
const idl = JSON.parse(
  readFileSync(new URL("../idl/outcomia.json", import.meta.url)),
);
const p = new Program(idl, { connection: {} });
const key = (n) => new PublicKey(Buffer.alloc(32, n));
const owner = key(2),
  maker = key(3),
  market = key(4),
  mint = key(5),
  bookKey = m.multiBookPda(market);
const terms = {
  resolver: owner,
  fallback: null,
  outcomeLabels: ["A", "B", "C"],
  questionHash: Array(32).fill(1),
  rulesHash: Array(32).fill(2),
  rulesUri: "https://example.com/rules",
  closeTs: new BN(2000000000),
  earliestResolutionTs: null,
  resolutionDelaySeconds: new BN(60),
  payoutPerContract: new BN(1000000),
  priceTick: new BN(10000),
  quantityLot: new BN(3),
};
function fixture() {
  const rows = [1, 2].map((id, i) => ({
    publicKey: m.multiOrderPda(bookKey, new BN(id)),
    account: {
      owner: maker,
      market,
      book: bookKey,
      orderId: new BN(id),
      outcome: [0],
      side: { ask: {} },
      price: new BN(100000),
      quantity: new BN(3),
      remainingQuantity: new BN(3),
      lockedAmount: new BN(3),
      status: { open: {} },
      previous: i ? m.multiOrderPda(bookKey, new BN(1)) : null,
      next: i ? null : m.multiOrderPda(bookKey, new BN(2)),
    },
  }));
  const heads = Array(16).fill(null);
  heads[1] = { order: rows[0].publicKey, ...rows[0].account };
  return {
    rows,
    book: {
      market,
      authority: owner,
      heads,
      nextOrderId: new BN(3),
      openOrderCount: new BN(2),
      accruedCollateralFees: new BN(0),
    },
    market: { terms, collateralMint: mint },
  };
}
test("real IDL encodes OutcomeId tuple and packs FIFO fills with a safe remainder", async () => {
  const f = fixture();
  const plan = await m.buildMultiTrade(
    p,
    market,
    f.market,
    f.book,
    f.rows,
    owner,
    0,
    "bid",
    new BN(100000),
    new BN(9),
    100,
  );
  assert.equal(plan.transaction.instructions.length, 3);
  const decoded = plan.transaction.instructions.map((ix) =>
    p.coder.instruction.decode(ix.data),
  );
  assert.equal(decoded[0].name, "matchMultiOutcomeOrder");
  assert.equal(decoded[0].data.outcome[0], 0);
  assert.equal(decoded[2].name, "placeMultiOutcomeOrder");
  assert.equal(decoded[2].data.quantity.toString(), "3");
  assert.equal(plan.fees.toString(), "6000");
  assert.equal(plan.remaining.toString(), "0");
  assert.ok(m.transactionBytes(plan.transaction, owner) <= 1232);
});
test("broken FIFO links, missing orders, self trades and invalid lots fail closed", async () => {
  const f = fixture();
  f.rows[1].account.previous = null;
  assert.throws(() => m.validateBook(market, f.book, f.rows), /reciprocal/);
  assert.throws(() => m.validateBook(market, fixture().book, []), /incomplete/);
  const g = fixture();
  g.rows[0].account.owner = owner;
  await assert.rejects(
    m.buildMultiTrade(
      p,
      market,
      g.market,
      g.book,
      g.rows,
      owner,
      0,
      "bid",
      new BN(100000),
      new BN(3),
      100,
    ),
    /own order/,
  );
  assert.throws(
    () => m.validateOrder(terms, 0, new BN(100000), new BN(1)),
    /lot/,
  );
});
test("creation selects bounded direct or chunked maximum terms with exact hash and sizes", async () => {
  const short = await creation.creationTransactions(
    p,
    owner,
    Buffer.alloc(32, 1),
    mint,
    terms,
    "Question",
    "USDC",
  );
  assert.equal(short.uploads.length, 0);
  assert.ok(m.transactionBytes(short.create, owner) <= 1232);
  const long = {
    ...terms,
    fallback: {
      resolver: maker,
      availableTs: new BN(2000000010),
      deadlineTs: new BN(2000000020),
    },
    outcomeLabels: Array.from({ length: 8 }, (_, i) => `${i}${"x".repeat(63)}`),
    rulesUri: `https://${"x".repeat(192)}`,
    quantityLot: new BN(8),
  };
  const plan = await creation.creationTransactions(
    p,
    owner,
    Buffer.alloc(32, 2),
    mint,
    long,
    "Question",
    "USDC",
  );
  assert.ok(plan.uploads.length >= 2);
  assert.ok(plan.cleanup);
  for (const tx of [...plan.uploads, plan.create, plan.cleanup])
    assert.ok(m.transactionBytes(tx, owner) <= 1232);
  const bytes = p.coder.types.encode("multiOutcomeTerms", long),
    decoded = p.coder.instruction.decode(plan.create.instructions[0].data);
  assert.deepEqual(
    [...decoded.data.termsHash],
    [...(await creation.sha256(bytes))],
  );
});
test("smoke discovery filters preserve normal market questions", () => {
  const visibility = loadTypeScript(
    new URL("../lib/market-visibility.ts", import.meta.url),
  );
  assert.equal(
    visibility.visiblePredictionMarket(
      "4AhXYjfYy5kVBTyWbmrxFJ7KmydghcaktprU74aVv5kC",
      "Anything",
    ),
    false,
  );
  assert.equal(
    visibility.visiblePredictionMarket(
      "other",
      "SMOKE ONLY - shared wallet settlement",
    ),
    false,
  );
  assert.equal(
    visibility.visiblePredictionMarket("other", "Will candidate A win?"),
    true,
  );
});
