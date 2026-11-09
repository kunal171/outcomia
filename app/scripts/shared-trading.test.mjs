// Execute the actual planner and Anchor instruction encoder without a wallet or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const require = createRequire(import.meta.url),
  { BN, Program } = require("@anchor-lang/core"),
  { PublicKey, Connection, Transaction } = require("@solana/web3.js");
const idl = JSON.parse(
    readFileSync(new URL("../idl/outcomia.json", import.meta.url), "utf8"),
  ),
  programId = new PublicKey(idl.address),
  p = new Program(idl, { connection: new Connection("http://127.0.0.1:8899") });
const derive = (seed, ...parts) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], programId)[0];
const mod = { exports: {} };
runInNewContext(
  ts.transpileModule(
    readFileSync(new URL("../lib/shared.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    },
  ).outputText,
  {
    module: mod,
    exports: mod.exports,
    Buffer,
    process: { env: {} },
    require: (name) =>
      name === "./solana"
        ? { PROGRAM_ID: programId }
        : name === "./outcomia"
          ? { deriveProtocolConfigPda: () => derive("protocol_config") }
          : name === "./prediction"
            ? {
                derivePredictionPositionPda: (market, owner) =>
                  derive(
                    "prediction_position",
                    market.toBuffer(),
                    owner.toBuffer(),
                  ),
              }
            : require(name),
  },
);
const s = mod.exports,
  key = (n) => new PublicKey(Buffer.alloc(32, n)),
  bn = (n) => new BN(String(n)),
  owner = key(1),
  maker = key(2),
  market = key(3),
  base = key(4),
  quote = key(5);
function fixture(prediction = false) {
  return {
    key: s.sharedBookPda(market),
    book: {
      market,
      authority: owner,
      kind: prediction ? { prediction: {} } : { spot: {} },
      baseMint: prediction ? PublicKey.default : base,
      quoteMint: quote,
      baseDecimals: 0,
      quoteDecimals: 6,
      priceTick: bn(10),
      quantityLot: bn(1),
      payoutPerContract: bn(prediction ? 1_000_000 : 0),
      bestPrices: [null, null, null, null],
      nextOrderId: bn(50),
      openOrderCount: bn(0),
      accruedQuoteFees: bn(0),
    },
    orders: [],
    levels: [],
  };
}
function add(
  f,
  id,
  price,
  quantity = 1,
  side = "ask",
  outcome = "spot",
  wallet = maker,
) {
  const orderKey = s.sharedOrderPda(f.key, bn(id)),
    levelKey = s.sharedLevelPda(f.key, outcome, side, bn(price));
  let l = f.levels.find((r) => r.publicKey.equals(levelKey));
  if (!l) {
    l = {
      publicKey: levelKey,
      account: {
        book: f.key,
        market,
        outcome: s.variant(outcome),
        side: s.variant(side),
        price: bn(price),
        betterPrice: null,
        worsePrice: null,
        firstOrder: null,
        lastOrder: null,
        orderCount: bn(0),
        totalRemainingQuantity: bn(0),
        rentPayer: wallet,
      },
    };
    f.levels.push(l);
  }
  const previous = l.account.lastOrder;
  if (previous)
    f.orders.find((r) => r.publicKey.equals(previous)).account.nextOrder =
      orderKey;
  f.orders.push({
    publicKey: orderKey,
    account: {
      owner: wallet,
      market,
      book: f.key,
      orderId: bn(id),
      outcome: s.variant(outcome),
      side: s.variant(side),
      price: bn(price),
      priceLevel: levelKey,
      previousOrder: previous,
      nextOrder: null,
      quantity: bn(quantity),
      remainingQuantity: bn(quantity),
      lockedCollateral: bn(side === "ask" ? quantity : price * quantity),
      status: { open: {} },
    },
  });
  l.account.firstOrder ??= orderKey;
  l.account.lastOrder = orderKey;
  l.account.orderCount = l.account.orderCount.addn(1);
  l.account.totalRemainingQuantity =
    l.account.totalRemainingQuantity.addn(quantity);
  const sorted = f.levels
    .filter((r) => outcome in r.account.outcome && side in r.account.side)
    .sort((a, b) =>
      side === "ask"
        ? a.account.price.cmp(b.account.price)
        : b.account.price.cmp(a.account.price),
    );
  sorted.forEach((r, i) => {
    r.account.betterPrice = sorted[i - 1]?.account.price ?? null;
    r.account.worsePrice = sorted[i + 1]?.account.price ?? null;
  });
  return orderKey;
}
const name = (i) => p.coder.instruction.decode(i.data).name;
function account(i, n) {
  const instruction = idl.instructions.find(
    (x) => x.name === name(i).replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()),
  );
  return i.keys[instruction.accounts.findIndex((x) => x.name === n)].pubkey;
}

test("empty spot uses one shared placement and program-ID optional sentinels", async () => {
  const f = fixture(),
    r = await s.buildSharedTrade(p, f, owner, "spot", "bid", bn(100), bn(3));
  assert.equal(r.instructions.length, 1);
  assert.equal(name(r.instructions[0]), "placeSharedOrder");
  assert(account(r.instructions[0], "position").equals(programId));
  assert(
    account(r.instructions[0], "quote_balance").equals(
      s.assetBalancePda(owner, quote),
    ),
  );
  assert(r.remaining.isZero());
});
test("same-price FIFO append and sorted insertion encode exact neighbors", async () => {
  const f = fixture(),
    old = add(f, 1, 100, 2, "bid");
  add(f, 2, 80, 1, "bid");
  const append = await s.buildSharedTrade(
    p,
    f,
    owner,
    "spot",
    "bid",
    bn(100),
    bn(1),
  );
  assert(account(append.instructions[0], "tail").equals(old));
  const middle = await s.buildSharedTrade(
    p,
    f,
    owner,
    "spot",
    "bid",
    bn(90),
    bn(1),
  );
  assert(
    account(middle.instructions[0], "better_level").equals(
      s.sharedLevelPda(f.key, "spot", "bid", bn(100)),
    ),
  );
  assert(
    account(middle.instructions[0], "worse_level").equals(
      s.sharedLevelPda(f.key, "spot", "bid", bn(80)),
    ),
  );
});
test("two FIFO fills promote the next head then post a safe remainder", async () => {
  const f = fixture(),
    first = add(f, 1, 100),
    second = add(f, 2, 100);
  const r = await s.buildSharedTrade(
    p,
    f,
    owner,
    "spot",
    "bid",
    bn(100),
    bn(3),
  );
  assert.deepEqual(Array.from(r.instructions, name), [
    "matchSharedOrder",
    "matchSharedOrder",
    "placeSharedOrder",
  ]);
  assert(account(r.instructions[0], "next_order").equals(second));
  assert(account(r.instructions[1], "level_rent_recipient").equals(maker));
  assert(account(r.instructions[0], "maker_order").equals(first));
  assert(f.orders[0].account.remainingQuantity.eqn(1));
});
test("crossing three-maker cap never posts an unsafe remainder", async () => {
  const f = fixture();
  for (let i = 1; i <= 4; i++) add(f, i, 100 + i * 10);
  const r = await s.buildSharedTrade(
    p,
    f,
    owner,
    "spot",
    "bid",
    bn(200),
    bn(4),
  );
  assert.equal(r.instructions.length, 3);
  assert(r.remaining.eqn(1));
  assert(r.instructions.every((i) => name(i) === "matchSharedOrder"));
});
test("prediction trades bind global collateral and question-specific positions", async () => {
  const f = fixture(true);
  add(f, 1, 400_000, 2, "ask", "no");
  const r = await s.buildSharedTrade(
    p,
    f,
    owner,
    "no",
    "bid",
    bn(500_000),
    bn(1),
  );
  assert.equal(r.instructions.length, 1);
  assert(account(r.instructions[0], "taker_base").equals(programId));
  assert(
    account(r.instructions[0], "taker_quote").equals(
      s.assetBalancePda(owner, quote),
    ),
  );
  assert(
    account(r.instructions[0], "taker_position").equals(
      derive("prediction_position", market.toBuffer(), owner.toBuffer()),
    ),
  );
});
test("self-trade and bad increments fail before building a signed transaction", async () => {
  const f = fixture();
  add(f, 1, 100, 1, "ask", "spot", owner);
  await assert.rejects(
    s.buildSharedTrade(p, f, owner, "spot", "bid", bn(100), bn(1)),
    /Your order/,
  );
  await assert.rejects(
    s.buildSharedTrade(p, fixture(), owner, "spot", "bid", bn(101), bn(1)),
    /increments/,
  );
});
test("owner cancellation has no lifecycle gate and returns rent to the original payer", async () => {
  const f = fixture(),
    o = add(f, 1, 100, 1, "ask", "spot", owner);
  const i = await s.cancelShared(p, f, owner, o);
  assert.equal(name(i), "cancelSharedOrder");
  assert(account(i, "level_rent_recipient").equals(owner));
  await assert.rejects(s.cancelShared(p, f, maker, o), /owner/);
});
test("packet guard accepts a normal trade and rejects excessive account batches", async () => {
  const f = fixture(),
    r = await s.buildSharedTrade(p, f, owner, "spot", "bid", bn(100), bn(1));
  s.assertSharedTransactionFits(
    new Transaction().add(...r.instructions),
    owner,
  );
  const tx = new Transaction();
  for (let i = 1; i <= 40; i++)
    tx.add({
      ...r.instructions[0],
      keys: [
        ...r.instructions[0].keys,
        { pubkey: key(i + 50), isSigner: false, isWritable: true },
      ],
    });
  assert.throws(() => s.assertSharedTransactionFits(tx, owner), /packet limit/);
});

test("a zero-notional dust remainder stays free without rolling back valid fills", async () => {
  const f = fixture();
  f.book.baseDecimals = 6;
  f.book.priceTick = bn(1);
  add(f, 1, 10000, 100);
  const r = await s.buildSharedTrade(
    p,
    f,
    owner,
    "spot",
    "bid",
    bn(10000),
    bn(101),
  );
  assert.equal(r.instructions.length, 1);
  assert.equal(name(r.instructions[0]), "matchSharedOrder");
  assert.equal(r.stopReason, "zero-notional");
  assert(r.remaining.eqn(1));
});
