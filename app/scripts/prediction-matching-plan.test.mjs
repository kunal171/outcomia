// Exercise the actual TypeScript planner with deterministic account readers.
// Instruction encoding uses the checked-in IDL; no network or wallet is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { BN, Program } = require("@anchor-lang/core");
const {
  PublicKey,
  Connection,
  Transaction,
  ComputeBudgetProgram,
  ComputeBudgetInstruction,
} = require("@solana/web3.js");
const idl = JSON.parse(
  readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
);
const programId = new PublicKey(idl.address);
function load(file, overrides) {
  const module = { exports: {} };
  const output = ts.transpileModule(
    readFileSync(new URL(file, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    },
  ).outputText;
  runInNewContext(output, {
    module,
    exports: module.exports,
    Buffer,
    process: { env: {} },
    require: (name) =>
      Object.hasOwn(overrides, name) ? overrides[name] : require(name),
  });
  return module.exports;
}
const prediction = load("../lib/prediction.ts", {
  "./solana": { PROGRAM_ID: programId },
});
const derive = (seed, ...keys) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...keys.map((k) => k.toBuffer())],
    programId,
  )[0];
const {
  planPredictionMatches,
  buildPredictionMatchTransaction,
  MAX_PREDICTION_MATCHES_PER_TRANSACTION,
  PREDICTION_MATCH_COMPUTE_UNITS,
} = load("../lib/prediction-matching-plan.ts", {
  "./prediction": prediction,
  "./tidebook": {
    deriveMarketFeesPda: (market) => derive("market_fees", market),
    deriveProtocolConfigPda: () => derive("protocol_config"),
  },
});
const key = (seed) => new PublicKey(new Uint8Array(32).fill(seed));
const bn = (value) => new BN(String(value));
const maximum = "18446744073709551615";

/** Build sorted levels and canonical FIFO accounts, with real per-owner locks.
 * The caller may deliberately corrupt returned maps to test fail-closed reads. */
function fixture({
  outcome = "yes",
  side = "bid",
  levels = [{ price: 600000, quantities: [2, 3, 4] }],
  fee = 100,
  cash = 10000000,
  contracts = 100,
  owners = [],
} = {}) {
  const marketAddress = prediction.derivePredictionMarketPda(
    new Uint8Array(32).fill(7),
  );
  const taker = key(9),
    makerSide = side === "bid" ? "ask" : "bid";
  const orders = new Map(),
    priceLevels = new Map(),
    positions = new Map(),
    reads = [];
  const market = {
    status: { open: {} },
    closeTs: bn(1000),
    payoutPerContract: bn(1000000),
    priceTick: bn(10000),
    openOrderCount: bn(0),
  };
  const book = {
    market: marketAddress,
    nextOrderId: bn(1),
    yesBestBid: null,
    yesBestAsk: null,
    noBestBid: null,
    noBestAsk: null,
  };
  const position = {
    market: marketAddress,
    owner: taker,
    collateralFree: bn(cash),
    collateralLocked: bn(0),
    yesFree: bn(contracts),
    yesLocked: bn(0),
    noFree: bn(contracts),
    noLocked: bn(0),
  };
  const levelKey = (price) =>
    prediction.derivePredictionPriceLevelPda(
      marketAddress,
      outcome,
      makerSide,
      bn(price),
    );
  const orderKey = (id) =>
    prediction.derivePredictionOrderPda(marketAddress, bn(id));
  let id = 1;
  for (const [index, spec] of levels.entries()) {
    const first = id,
      total = spec.quantities.reduce((sum, qty) => sum + qty, 0);
    const levelAddress = levelKey(spec.price);
    for (const [offset, qty] of spec.quantities.entries()) {
      const owner = key(owners[id - 1] ?? 11);
      const positionAddress = prediction.derivePredictionPositionPda(
        marketAddress,
        owner,
      );
      const makerPosition = positions.get(positionAddress.toBase58()) ?? {
        ...position,
        owner,
        collateralFree: bn(0),
        yesFree: bn(0),
        noFree: bn(0),
      };
      const lock = makerSide === "bid" ? bn(spec.price).mul(bn(qty)) : bn(qty);
      if (makerSide === "bid")
        makerPosition.collateralLocked =
          makerPosition.collateralLocked.add(lock);
      else {
        const bucket = outcome === "yes" ? "yesLocked" : "noLocked";
        makerPosition[bucket] = makerPosition[bucket].add(lock);
      }
      positions.set(positionAddress.toBase58(), makerPosition);
      orders.set(orderKey(id).toBase58(), {
        market: marketAddress,
        owner,
        orderId: bn(id),
        outcome: { [outcome]: {} },
        side: { [makerSide]: {} },
        price: bn(spec.price),
        priceLevel: levelAddress,
        quantity: bn(qty),
        remainingQuantity: bn(qty),
        lockedCollateral: lock,
        status: { open: {} },
        previousOrder: offset ? orderKey(id - 1) : null,
        nextOrder:
          offset + 1 < spec.quantities.length ? orderKey(id + 1) : null,
      });
      id++;
    }
    priceLevels.set(levelAddress.toBase58(), {
      market: marketAddress,
      outcome: { [outcome]: {} },
      side: { [makerSide]: {} },
      price: bn(spec.price),
      betterPrice: index ? bn(levels[index - 1].price) : null,
      worsePrice: levels[index + 1] ? bn(levels[index + 1].price) : null,
      firstOrder: orderKey(first),
      lastOrder: orderKey(id - 1),
      orderCount: bn(spec.quantities.length),
      totalRemainingQuantity: bn(total),
      rentPayer: key(30 + index),
    });
  }
  const head =
    outcome === "yes"
      ? makerSide === "bid"
        ? "yesBestBid"
        : "yesBestAsk"
      : makerSide === "bid"
        ? "noBestBid"
        : "noBestAsk";
  book[head] = levels.length ? bn(levels[0].price) : null;
  book.nextOrderId = bn(id);
  market.openOrderCount = bn(id - 1);
  const reader = (map, name) => ({
    fetchNullable: async (address) => {
      reads.push([name, address.toBase58()]);
      return map.get(address.toBase58()) ?? null;
    },
  });
  const accounts = {
    predictionOrder: reader(orders, "order"),
    predictionPriceLevel: reader(priceLevels, "level"),
    predictionPosition: reader(positions, "position"),
  };
  const request = {
    marketAddress,
    taker,
    outcome,
    side,
    limitPrice: bn(side === "bid" ? 900000 : 100000),
    quantity: bn(6),
  };
  const run = (quantity = 6, accrued = bn(0)) =>
    planPredictionMatches(
      accounts,
      { ...request, quantity: bn(quantity) },
      market,
      book,
      position,
      fee,
      accrued,
      bn(100),
    );
  const snapshot = () =>
    JSON.stringify({
      orders: [...orders],
      levels: [...priceLevels],
      positions: [...positions],
      market,
      book,
      position,
      request,
    });
  return {
    run,
    accounts,
    orders,
    priceLevels,
    positions,
    reads,
    market,
    book,
    position,
    request,
    levelKey,
    orderKey,
    snapshot,
  };
}

test("same-price batches simulate FIFO promotion for all four prediction lists", async () => {
  for (const outcome of ["yes", "no"])
    for (const side of ["bid", "ask"]) {
      const f = fixture({ outcome, side });
      const before = f.snapshot();
      const plan = await f.run(6);
      assert.equal(plan.steps.length, 3);
      assert.deepEqual(
        Array.from(plan.steps, (step) => step.fillQuantity.toNumber()),
        [2, 3, 1],
      );
      assert.deepEqual(
        Array.from(plan.steps, (step) => step.requestedQuantity.toNumber()),
        [6, 4, 1],
      );
      assert.equal(plan.steps[1].target.maker.previousOrder, null);
      assert.equal(
        plan.steps[1].target.level.firstOrder.toBase58(),
        f.orderKey(2).toBase58(),
      );
      assert.equal(plan.steps[2].target.level.orderCount.toNumber(), 1);
      assert.equal(plan.steps[2].target.nextOrder, null);
      assert.equal(plan.steps[2].target.rentRecipient, null); // Final step is partial.
      assert.equal(plan.stopReason, "filled");
      assert.equal(plan.remainingQuantity.toNumber(), 0);
      assert.equal(plan.totalNotional.toNumber(), 3600000);
      assert.equal(plan.totalFee.toNumber(), 36000);
      assert.equal(
        plan.totalCash.toNumber(),
        side === "bid" ? 3636000 : 3564000,
      );
      assert.equal(f.snapshot(), before);
    }
});

test("batches promote multiple price levels in best-price order", async () => {
  for (const outcome of ["yes", "no"])
    for (const side of ["bid", "ask"]) {
      const prices =
        side === "bid" ? [600000, 610000, 620000] : [600000, 590000, 580000];
      const f = fixture({
        outcome,
        side,
        levels: prices.map((price) => ({ price, quantities: [1] })),
      });
      const plan = await f.run(5);
      assert.equal(plan.stopReason, "book-exhausted");
      assert.equal(plan.remainingQuantity.toNumber(), 2);
      assert.deepEqual(
        Array.from(plan.steps, (s) => s.target.maker.price.toNumber()),
        prices,
      );
      assert.equal(plan.steps[1].target.level.betterPrice, null);
      assert.equal(plan.steps[2].target.level.betterPrice, null);
      assert.equal(plan.steps[2].target.worseLevel, null);
      assert.equal(
        plan.steps[2].target.rentRecipient.toBase58(),
        key(32).toBase58(),
      );
    }
});

test("cap distinguishes crossing liquidity, empty book and a non-crossing boundary", async () => {
  const capped = fixture({
    levels: [{ price: 600000, quantities: [1, 1, 1, 9] }],
  });
  const plan = await capped.run(10);
  assert.equal(plan.stopReason, "match-cap");
  assert.equal(plan.remainingQuantity.toNumber(), 7);
  assert.equal(plan.steps.length, MAX_PREDICTION_MATCHES_PER_TRANSACTION);
  // The fourth order is read only as the third step's mandatory successor.
  // Its maker position is never visited and it gets no matching instruction.
  assert.equal(
    plan.steps[2].target.nextOrder.toBase58(),
    capped.orderKey(4).toBase58(),
  );
  const empty = fixture({ levels: [{ price: 600000, quantities: [1, 1, 1] }] });
  assert.equal((await empty.run(10)).stopReason, "book-exhausted");
  const noncrossing = fixture({
    levels: [
      { price: 600000, quantities: [1, 1, 1] },
      { price: 800000, quantities: [1] },
    ],
  });
  noncrossing.request.limitPrice = bn(700000);
  assert.equal((await noncrossing.run(10)).stopReason, "non-crossing");
});

test("fees are rounded per fill before summation", async () => {
  const f = fixture({ levels: [{ price: 1, quantities: [1, 1, 1] }], fee: 1 });
  f.market.priceTick = bn(1);
  const plan = await f.run(3);
  assert.equal(plan.totalNotional.toNumber(), 3);
  assert.equal(plan.totalFee.toNumber(), 3); // ceil(1/10000) three times, not ceil(3/10000).
  assert.equal(plan.totalCash.toNumber(), 6);
});

test("cumulative funds and receiving limits include earlier fills", async () => {
  const buy = fixture({
    levels: [{ price: 600000, quantities: [1, 1] }],
    cash: 700000,
  });
  await assert.rejects(() => buy.run(2), /Not enough free funds/);
  const sell = fixture({
    side: "ask",
    levels: [{ price: 600000, quantities: [1, 1] }],
    contracts: 1,
  });
  await assert.rejects(() => sell.run(2), /Not enough free funds/);
  const receive = fixture({ levels: [{ price: 600000, quantities: [1, 1] }] });
  receive.position.yesFree = bn(maximum).subn(1);
  await assert.rejects(() => receive.run(2), /Receiving balance/);
  const fees = fixture({ levels: [{ price: 600000, quantities: [1, 1] }] });
  await assert.rejects(
    () => fees.run(2, bn(maximum).subn(6000)),
    /Accrued fees/,
  );
});

test("one maker owner can appear repeatedly without resetting its virtual ledger", async () => {
  const f = fixture({
    levels: [{ price: 600000, quantities: [1, 1, 1] }],
    owners: [11, 12, 11],
  });
  const owner11 = prediction
    .derivePredictionPositionPda(f.request.marketAddress, key(11))
    .toBase58();
  f.positions.get(owner11).collateralFree = bn(maximum).subn(900000);
  await assert.rejects(() => f.run(3), /Maker cash/); // Both credits go to owner 11.
});

test("self-trades anywhere on the selected path reject the whole plan", async () => {
  for (const owners of [
    [9, 11],
    [11, 9],
  ]) {
    const f = fixture({
      levels: [{ price: 600000, quantities: [1, 1] }],
      owners,
    });
    await assert.rejects(() => f.run(2), /own order/);
  }
});

test("no liquidity and non-crossing limits return empty plans without a transaction", async () => {
  const f = fixture({ levels: [] });
  const empty = await f.run();
  assert.equal(empty.stopReason, "book-exhausted");
  assert.equal(empty.steps.length, 0);
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  await assert.rejects(
    () => buildPredictionMatchTransaction(program, empty),
    /No crossing orders/,
  );
  const g = fixture();
  g.request.limitPrice = bn(500000);
  assert.equal((await g.run()).stopReason, "non-crossing");
  assert.equal(g.reads.length, 0);
});

test("bad input is rejected even on an empty book", async () => {
  for (const quantity of [0, -1, "18446744073709551616"])
    await assert.rejects(
      () => fixture({ levels: [] }).run(quantity),
      /positive whole u64/,
    );
  for (const mutate of [
    (f) => {
      f.market.status = { frozen: {} };
    },
    (f) => {
      f.market.closeTs = bn(100);
    },
    (f) => {
      f.book.market = key(7);
    },
    (f) => {
      f.position.owner = key(7);
    },
    (f) => {
      f.request.limitPrice = bn(600001);
    },
  ]) {
    const f = fixture({ levels: [] });
    mutate(f);
    await assert.rejects(() => f.run());
  }
});

test("missing accounts, failed reads and corrupt reciprocal links never become stop reasons", async () => {
  for (const corrupt of [
    (f) => {
      f.priceLevels.get(f.levelKey(600000).toBase58()).firstOrder = null;
    },
    (f) => {
      f.orders.get(f.orderKey(2).toBase58()).previousOrder = null;
    },
    (f) => {
      f.orders.get(f.orderKey(2).toBase58()).nextOrder = f.orderKey(1);
    },
    (f) => {
      f.positions.clear();
    },
    (f) => {
      f.priceLevels.clear();
    },
    (f) => {
      f.accounts.predictionOrder.fetchNullable = async () => {
        throw new Error("RPC unavailable");
      };
    },
  ]) {
    const f = fixture();
    corrupt(f);
    await assert.rejects(() => f.run());
  }
  const f = fixture({
    levels: [
      { price: 600000, quantities: [1] },
      { price: 700000, quantities: [1] },
    ],
  });
  f.priceLevels.get(f.levelKey(700000).toBase58()).betterPrice = null;
  await assert.rejects(() => f.run(), /Next price level/);
});

test("maker position ownership and actual backing are checked", async () => {
  for (const mutate of [
    (p) => {
      p.owner = key(99);
    },
    (p) => {
      p.market = key(99);
    },
    (p) => {
      p.yesLocked = bn(0);
    },
  ]) {
    const f = fixture();
    const position = f.positions.values().next().value;
    mutate(position);
    await assert.rejects(() => f.run(), /ownership|back its order/);
  }
});

test("IDL builder creates exactly three matching instructions with one taker signature", async () => {
  const f = fixture();
  const plan = await f.run(6);
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const tx = await buildPredictionMatchTransaction(program, plan);
  assert.equal(tx.instructions.length, 4); // Budget plus three fills; no placement.
  assert.equal(
    tx.instructions[0].programId.toBase58(),
    ComputeBudgetProgram.programId.toBase58(),
  );
  assert.equal(
    ComputeBudgetInstruction.decodeSetComputeUnitLimit(tx.instructions[0])
      .units,
    PREDICTION_MATCH_COMPUTE_UNITS,
  );
  for (const [index, ix] of tx.instructions.slice(1).entries()) {
    const decoded = program.coder.instruction.decode(ix.data);
    assert.equal(decoded.name, "matchPredictionOrder");
    assert.equal(decoded.data.quantity.toString(), ["6", "4", "1"][index]);
    assert.equal(
      ix.keys[5].pubkey.toBase58(),
      f.orderKey(index + 1).toBase58(),
    );
    assert.equal(
      ix.keys[9].pubkey.toBase58(),
      index < 2
        ? f.orderKey(index + 2).toBase58()
        : program.programId.toBase58(),
    );
    assert.equal(ix.keys.filter((key) => key.isSigner).length, 1);
  }
  assert.equal(tx.recentBlockhash, undefined); // The dummy measurement hash does not escape.
  const measured = new Transaction({
    feePayer: f.request.taker,
    recentBlockhash: PublicKey.default.toBase58(),
  }).add(...tx.instructions);
  assert.ok(
    measured.serialize({ requireAllSignatures: false, verifySignatures: false })
      .length <= 1232,
  );
  await assert.rejects(
    () =>
      buildPredictionMatchTransaction(program, {
        ...plan,
        steps: [...plan.steps, plan.steps[0]],
      }),
    /Too many/,
  );
});

test("three-price transactions with distinct maker owners fit the legacy packet on all four lists", async () => {
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  for (const outcome of ["yes", "no"])
    for (const side of ["bid", "ask"]) {
      const prices =
        side === "bid" ? [600000, 610000, 620000] : [600000, 590000, 580000];
      const f = fixture({
        outcome,
        side,
        owners: [11, 12, 13],
        levels: prices.map((price) => ({ price, quantities: [1] })),
      });
      const plan = await f.run(10);
      const tx = await buildPredictionMatchTransaction(program, plan);
      const measured = new Transaction({
        feePayer: f.request.taker,
        recentBlockhash: PublicKey.default.toBase58(),
      }).add(...tx.instructions);
      assert.ok(
        measured.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }).length <= 1232,
      );
      assert.equal(tx.instructions.length, 4);
      assert.equal(plan.remainingQuantity.toNumber(), 7);
      assert.equal(
        plan.steps[2].target.rentRecipient.toBase58(),
        key(32).toBase58(),
      );
    }
});
