// Exercise the browser's pure parser in Node without loading Next.js or .env.
// TypeScript is already a dev dependency; no additional test runner is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { PublicKey } = require("@solana/web3.js");
const mod = { exports: {} };
const source = readFileSync(
  new URL("../lib/prediction.ts", import.meta.url),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
runInNewContext(code, {
  module: mod,
  exports: mod.exports,
  Buffer,
  TextEncoder,
  TextDecoder,
  crypto: webcrypto,
  process: { env: {} },
  require: (name) =>
    name === "./solana" ? { PROGRAM_ID: PublicKey.default } : require(name),
});
const {
  parsePredictionRules,
  derivePredictionMarketPda,
  derivePredictionPositionPda,
  derivePredictionBookPda,
  derivePredictionOrderPda,
  derivePredictionPriceLevelPda,
  validatePredictionDepositAmount,
  validatePredictionWithdrawalAmount,
  validatePredictionCompleteSet,
  PREDICTION_FUNDING_ENABLED,
  PREDICTION_OPENING_ENABLED,
  predictionOpeningIssue,
  validatePredictionCreatorResolver,
  validatePredictionRestingOrder,
  readPredictionPlacementTarget,
  readPredictionCancellationAccounts,
  readPredictionMatchTarget,
  validatePredictionMatch,
  PREDICTION_MATCHING_ENABLED,
  PREDICTION_CANCELLATION_ENABLED,
  PREDICTION_ORDERS_ENABLED,
} = mod.exports;

function rules() {
  return {
    schemaVersion: 1,
    question: "Will this proposal pass?",
    resolutionSource: "https://example.org/proposals/1",
    resolutionRules: {
      yesCriteria: "Proposal final state is succeeded before close.",
      noCriteria: "Proposal final state is defeated before close.",
      invalidCriteria: "Neither result can be established.",
      evidenceRequirements: "Final proposal account and timestamp.",
      conflictingEvidencePolicy: "Use the committed final account observation.",
    },
    primaryResolver: new PublicKey(new Uint8Array(32).fill(1)).toBase58(),
    closeTimestamp: 1900000000,
    earliestResolutionTimestamp: null,
    resolutionDelaySeconds: 3600,
    fallback: null,
  };
}

function bytes(value, pretty = false) {
  return new TextEncoder().encode(
    JSON.stringify(value, null, pretty ? 2 : undefined),
  ).buffer;
}

test("hashes exact document bytes and unnormalized UTF-8 question", async () => {
  const value = rules();
  value.question += " café";
  const raw = bytes(value, true);
  const result = await parsePredictionRules(raw);
  assert.equal(
    Buffer.from(result.rulesHash).toString("hex"),
    createHash("sha256").update(Buffer.from(raw)).digest("hex"),
  );
  assert.equal(
    Buffer.from(result.questionHash).toString("hex"),
    createHash("sha256").update(value.question).digest("hex"),
  );
  assert.notEqual(
    Buffer.from(result.rulesHash).toString("hex"),
    Buffer.from((await parsePredictionRules(bytes(value))).rulesHash).toString(
      "hex",
    ),
  );
  assert.equal(result.earliestResolutionTs, null);
  assert.equal(result.fallback, null);
});

test("optional fallback deadline has explicit timeout semantics", async () => {
  const value = rules();
  value.fallback = {
    resolver: new PublicKey(new Uint8Array(32).fill(2)).toBase58(),
    availableTimestamp: 1900086400,
    proposalDeadlineTimestamp: null,
    activation: "No primary proposal exists at the activation time",
    procedure: "Use the same source and evaluation criteria.",
    noProposalOutcome: "No automatic timeout; await resolver",
  };
  assert.equal(
    (await parsePredictionRules(bytes(value))).fallback.deadlineTs,
    null,
  );
  value.fallback.proposalDeadlineTimestamp = 1900172800;
  await assert.rejects(
    () => parsePredictionRules(bytes(value)),
    /timeout policy/,
  );
  value.fallback.noProposalOutcome = "Invalid after the proposal deadline";
  assert.equal(
    (await parsePredictionRules(bytes(value))).fallback.deadlineTs.toString(),
    "1900172800",
  );
  value.fallback.availableTimestamp = value.closeTimestamp;
  await assert.rejects(
    () => parsePredictionRules(bytes(value)),
    /Fallback times/,
  );
});

test("rejects ambiguous inputs and missing evaluation criteria", async () => {
  for (const field of [
    "yesCriteria",
    "noCriteria",
    "invalidCriteria",
    "evidenceRequirements",
    "conflictingEvidencePolicy",
  ]) {
    const value = rules();
    delete value.resolutionRules[field];
    await assert.rejects(() => parsePredictionRules(bytes(value)), /required/);
  }
  const value = rules();
  value.closeTimestamp = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(
    () => parsePredictionRules(bytes(value)),
    /integer Unix seconds/,
  );
  value.closeTimestamp = 1900000000;
  value.earliestResolutionTimestamp = value.closeTimestamp - 1;
  await assert.rejects(
    () => parsePredictionRules(bytes(value)),
    /before trading closes/,
  );
  value.earliestResolutionTimestamp = null;
  value.resolutionDelaySeconds = 0;
  await assert.rejects(() => parsePredictionRules(bytes(value)), /positive/);
  await assert.rejects(
    () => parsePredictionRules(new ArrayBuffer(128 * 1024 + 1)),
    /128 KiB/,
  );
});

test("PDA namespace matches Rust and requires a 32-byte market ID", () => {
  const id = new Uint8Array(32).fill(7);
  const expected = PublicKey.findProgramAddressSync(
    [Buffer.from("prediction_market"), Buffer.from(id)],
    PublicKey.default,
  )[0];
  assert.equal(derivePredictionMarketPda(id).toBase58(), expected.toBase58());
  assert.throws(
    () => derivePredictionMarketPda(new Uint8Array(31)),
    /32 bytes/,
  );
});

test("position PDA scopes the ledger to both market and wallet", () => {
  const market = new PublicKey(new Uint8Array(32).fill(3));
  const owner = new PublicKey(new Uint8Array(32).fill(4));
  const other = new PublicKey(new Uint8Array(32).fill(5));
  const expected = PublicKey.findProgramAddressSync(
    [Buffer.from("prediction_position"), market.toBuffer(), owner.toBuffer()],
    PublicKey.default,
  )[0];
  assert.equal(
    derivePredictionPositionPda(market, owner).toBase58(),
    expected.toBase58(),
  );
  assert.notEqual(
    derivePredictionPositionPda(market, other).toBase58(),
    expected.toBase58(),
  );
  assert.notEqual(
    derivePredictionPositionPda(other, owner).toBase58(),
    expected.toBase58(),
  );
});

test("prediction book, order and level addresses match Rust golden vectors", () => {
  const { BN } = require("@anchor-lang/core");
  const market = new PublicKey(new Uint8Array(32).fill(3));
  const value = new BN("0102030405060708", 16);
  assert.equal(
    derivePredictionBookPda(market).toBase58(),
    "2o2oe3DTgaHc2MzTxkecU3x23sE4MeNPsTSMC9JAzdY5",
  );
  assert.equal(
    derivePredictionOrderPda(market, value).toBase58(),
    "7aYy4r8ww7hs5bsT52www1gBYaZuVK58rBcJv2k2HoYz",
  );
  assert.equal(
    derivePredictionPriceLevelPda(market, "yes", "bid", value).toBase58(),
    "7vmpMMVMsgbR3oTLvCSAfftj8PAvHkpDYbujS3u61UkP",
  );
});

test("prediction queue namespaces isolate outcomes, sides, markets and prices", () => {
  const { BN } = require("@anchor-lang/core");
  const market = new PublicKey(new Uint8Array(32).fill(3));
  const other = new PublicKey(new Uint8Array(32).fill(4));
  const price = new BN(650000);
  const levels = ["yes", "no"].flatMap((outcome) =>
    ["bid", "ask"].map((side) =>
      derivePredictionPriceLevelPda(market, outcome, side, price).toBase58(),
    ),
  );
  assert.equal(new Set(levels).size, 4);
  assert.notEqual(
    levels[0],
    derivePredictionPriceLevelPda(other, "yes", "bid", price).toBase58(),
  );
  assert.notEqual(
    levels[0],
    derivePredictionPriceLevelPda(
      market,
      "yes",
      "bid",
      price.addn(1),
    ).toBase58(),
  );
  const spot = PublicKey.findProgramAddressSync(
    [
      Buffer.from("price_level"),
      market.toBuffer(),
      Buffer.from("bid"),
      price.toArrayLike(Buffer, "le", 8),
    ],
    PublicKey.default,
  )[0];
  assert.notEqual(levels[0], spot.toBase58());
  assert.notEqual(
    derivePredictionBookPda(market).toBase58(),
    derivePredictionBookPda(other).toBase58(),
  );
  assert.notEqual(
    derivePredictionOrderPda(market, new BN(1)).toBase58(),
    derivePredictionOrderPda(other, new BN(1)).toBase58(),
  );
});

test("prediction seeds preserve full u64 values and reject overflow and unknown selectors", () => {
  const { BN } = require("@anchor-lang/core");
  const market = new PublicKey(new Uint8Array(32).fill(3));
  const maximum = new BN("18446744073709551615");
  const first = derivePredictionOrderPda(market, maximum);
  assert.notEqual(
    first.toBase58(),
    derivePredictionOrderPda(market, maximum.subn(1)).toBase58(),
  );
  const expected = PublicKey.findProgramAddressSync(
    [Buffer.from("prediction_order"), market.toBuffer(), Buffer.alloc(8, 255)],
    PublicKey.default,
  )[0];
  assert.equal(first.toBase58(), expected.toBase58());
  for (const value of [new BN(-1), maximum.addn(1)]) {
    assert.throws(
      () => derivePredictionOrderPda(market, value),
      /unsigned u64/,
    );
    assert.throws(
      () => derivePredictionPriceLevelPda(market, "yes", "bid", value),
      /unsigned u64/,
    );
  }
  assert.throws(
    () => derivePredictionPriceLevelPda(market, "invalid", "bid", new BN(1)),
    /Outcome/,
  );
  assert.throws(
    () => derivePredictionPriceLevelPda(market, "yes", "buy", new BN(1)),
    /Side/,
  );
});

function restingFixture() {
  const { BN } = require("@anchor-lang/core");
  const { market, position } = completeSetFixture();
  position.market = new PublicKey(new Uint8Array(32).fill(3));
  market.priceTick = new BN(10000);
  market.openOrderCount = new BN(0);
  const book = {
    market: position.market,
    nextOrderId: new BN(1),
    yesBestBid: null,
    yesBestAsk: null,
    noBestBid: null,
    noBestAsk: null,
  };
  return { market, position, book };
}

test("resting preflight uses cash for buys and only the selected free outcome for sells", () => {
  const { BN } = require("@anchor-lang/core");
  const { market, position, book } = restingFixture();
  for (const outcome of ["yes", "no"])
    for (const side of ["bid", "ask"]) {
      assert.equal(
        validatePredictionRestingOrder(
          market,
          book,
          position,
          outcome,
          side,
          new BN(600000),
          new BN(3),
          new BN(99),
        ).toString(),
        side === "bid" ? "1800000" : "3",
      );
    }
  assert.equal(PREDICTION_ORDERS_ENABLED, false);
  assert.throws(
    () =>
      validatePredictionRestingOrder(
        market,
        book,
        position,
        "yes",
        "bid",
        new BN(600000),
        new BN(17),
        new BN(99),
      ),
    /available collateral/,
  );
  for (const outcome of ["yes", "no"])
    assert.throws(
      () =>
        validatePredictionRestingOrder(
          market,
          book,
          position,
          outcome,
          "ask",
          new BN(600000),
          new BN(4),
          new BN(99),
        ),
      /available.*contracts/,
    );
});

test("resting preflight rejects invalid grid, timing, counters, selectors and crossed or occupied sides", () => {
  const { BN } = require("@anchor-lang/core");
  const { market, position, book } = restingFixture();
  const run = (
    price = 600000,
    quantity = 1,
    side = "bid",
    outcome = "yes",
    now = 99,
  ) =>
    validatePredictionRestingOrder(
      market,
      book,
      position,
      outcome,
      side,
      new BN(price),
      new BN(quantity),
      new BN(now),
    );
  for (const price of [0, -1, 600001, 1000000, 1100000])
    assert.throws(() => run(price), /Price/);
  for (const quantity of [0, -1, "18446744073709551616"])
    assert.throws(() => run(600000, quantity), /positive whole/);
  assert.throws(
    () => run(600000, "18446744073709551615"),
    /collateral exceeds/,
  );
  assert.throws(() => run(600000, 1, "bid", "yes", 100), /before close/);
  for (const status of ["draft", "frozen", "proposed", "resolved"]) {
    market.status = { [status]: {} };
    assert.throws(() => run(), /open market/);
  }
  market.status = { open: {} };
  book.yesBestBid = new BN(500000);
  assert.throws(() => run(), /empty side/);
  book.yesBestBid = null;
  book.yesBestAsk = new BN(600000);
  assert.throws(() => run(), /would cross/);
  book.yesBestAsk = null;
  book.yesBestBid = new BN(600000);
  assert.throws(() => run(600000, 1, "ask"), /would cross/);
  book.yesBestBid = null;
  assert.throws(() => run(600000, 1, "buy"), /valid outcome and side/);
  assert.throws(
    () => run(600000, 1, "bid", "invalid"),
    /valid outcome and side/,
  );
  book.nextOrderId = new BN(0);
  assert.throws(() => run(), /counter/);
  book.nextOrderId = new BN("18446744073709551615");
  assert.throws(() => run(), /counter/);
  book.nextOrderId = new BN(1);
  market.openOrderCount = new BN("18446744073709551615");
  assert.throws(() => run(), /counter/);
  market.openOrderCount = new BN(0);
  for (const [side, outcome, field] of [
    ["bid", "yes", "collateralLocked"],
    ["ask", "yes", "yesLocked"],
    ["ask", "no", "noLocked"],
  ]) {
    const before = position[field];
    position[field] = new BN("18446744073709551615");
    assert.throws(() => run(600000, 1, side, outcome), /Locked balance/);
    position[field] = before;
  }
  market.priceTick = new BN(0);
  assert.throws(() => run(), /Price/);
  market.priceTick = new BN(10000);
  book.market = PublicKey.default;
  assert.throws(() => run(), /different markets/);
});

test("placement IDL binds a signed trader to exact units and canonical order/level accounts", async () => {
  const { Program, BN } = require("@anchor-lang/core");
  const { Connection, SystemProgram, Transaction } = require("@solana/web3.js");
  const idl = JSON.parse(
    readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
  );
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const owner = new PublicKey(new Uint8Array(32).fill(4)),
    market = new PublicKey(new Uint8Array(32).fill(3));
  const derive = (seed, ...keys) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(seed), ...keys],
      program.programId,
    )[0];
  for (const outcome of ["yes", "no"])
    for (const side of ["bid", "ask"]) {
      const id = new BN(1),
        price = new BN(600000),
        quantity = new BN(10);
      const ix = await program.methods
        .placePredictionOrder(
          id,
          { [outcome]: {} },
          { [side]: {} },
          price,
          quantity,
        )
        .accountsStrict({
          owner,
          market,
          position: derive(
            "prediction_position",
            market.toBuffer(),
            owner.toBuffer(),
          ),
          orderBook: derive("prediction_book", market.toBuffer()),
          priceLevel: derive(
            "prediction_level",
            market.toBuffer(),
            Buffer.from(outcome),
            Buffer.from(side),
            price.toArrayLike(Buffer, "le", 8),
          ),
          order: derive(
            "prediction_order",
            market.toBuffer(),
            id.toArrayLike(Buffer, "le", 8),
          ),
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const decoded = program.coder.instruction.decode(ix.data);
      assert.equal(decoded.name, "placePredictionOrder");
      assert.equal(decoded.data.price.toString(), "600000");
      assert.equal(decoded.data.quantity.toString(), "10");
      assert.ok(outcome in decoded.data.outcome);
      assert.ok(side in decoded.data.side);
      assert.equal(ix.keys.length, 7);
      assert.equal(ix.keys[0].isSigner, true);
      for (let i = 0; i < 6; i++) assert.equal(ix.keys[i].isWritable, true);
      const tx = new Transaction({
        feePayer: owner,
        recentBlockhash: PublicKey.default.toBase58(),
      }).add(ix);
      assert.ok(
        tx.serialize({ requireAllSignatures: false, verifySignatures: false })
          .length <= 1232,
      );
    }
});

function appendFixture(outcome = "yes", side = "bid") {
  const { BN } = require("@anchor-lang/core");
  const fixture = restingFixture();
  const { book, position } = fixture;
  const price = new BN(600000),
    id = new BN(1);
  const levelAddress = derivePredictionPriceLevelPda(
      book.market,
      outcome,
      side,
      price,
    ),
    tailAddress = derivePredictionOrderPda(book.market, id);
  book.nextOrderId = new BN(2);
  book[
    outcome === "yes"
      ? side === "bid"
        ? "yesBestBid"
        : "yesBestAsk"
      : side === "bid"
        ? "noBestBid"
        : "noBestAsk"
  ] = price;
  const level = {
    market: book.market,
    outcome: { [outcome]: {} },
    side: { [side]: {} },
    price,
    betterPrice: null,
    worsePrice: null,
    firstOrder: tailAddress,
    lastOrder: tailAddress,
    totalRemainingQuantity: new BN(2),
    orderCount: new BN(1),
  };
  const tail = {
    owner: new PublicKey(new Uint8Array(32).fill(5)),
    market: book.market,
    orderId: id,
    outcome: { [outcome]: {} },
    side: { [side]: {} },
    price,
    priceLevel: levelAddress,
    previousOrder: null,
    nextOrder: null,
    quantity: new BN(2),
    remainingQuantity: new BN(2),
    lockedCollateral: new BN(side === "bid" ? 1200000 : 2),
    status: { open: {} },
  };
  return {
    ...fixture,
    append: { kind: "append", levelAddress, tailAddress, level, tail },
  };
}

test("append preflight preserves FIFO identity and uses the new trader's selected asset", () => {
  const { BN } = require("@anchor-lang/core");
  for (const outcome of ["yes", "no"])
    for (const side of ["bid", "ask"]) {
      const { market, book, position, append } = appendFixture(outcome, side);
      assert.equal(
        validatePredictionRestingOrder(
          market,
          book,
          position,
          outcome,
          side,
          new BN(600000),
          new BN(3),
          new BN(99),
          append,
        ).toString(),
        side === "bid" ? "1800000" : "3",
      );
      assert.equal(append.tail.nextOrder, null);
      assert.equal(append.level.orderCount.toString(), "1");
      assert.equal(book.nextOrderId.toString(), "2");
    }
});

test("append preflight rejects stale tails, wrong identities, closed orders and bad endpoints", () => {
  const { BN } = require("@anchor-lang/core");
  for (const corrupt of [
    (x) => (x.append.tail.nextOrder = PublicKey.default),
    (x) => (x.append.tail.status = { filled: {} }),
    (x) => (x.append.tail.outcome = { no: {} }),
    (x) => (x.append.tail.side = { ask: {} }),
    (x) => (x.append.tail.market = PublicKey.default),
    (x) => (x.append.tail.priceLevel = PublicKey.default),
    (x) => (x.append.tail.remainingQuantity = new BN(0)),
    (x) => (x.append.tail.remainingQuantity = new BN(3)),
    (x) => (x.append.level.lastOrder = PublicKey.default),
    (x) => (x.append.tailAddress = PublicKey.default),
    (x) => (x.append.tail.previousOrder = PublicKey.default),
    (x) => (x.append.level.firstOrder = null),
    (x) => (x.append.level.totalRemainingQuantity = new BN(1)),
    (x) => (x.append.level.outcome = { no: {} }),
    (x) => (x.append.level.market = PublicKey.default),
    (x) => (x.append.level.price = new BN(610000)),
    (x) => (x.append.levelAddress = PublicKey.default),
    (x) => (x.book.yesBestBid = null),
  ]) {
    const x = appendFixture();
    corrupt(x);
    assert.throws(
      () =>
        validatePredictionRestingOrder(
          x.market,
          x.book,
          x.position,
          "yes",
          "bid",
          new BN(600000),
          new BN(1),
          new BN(99),
          x.append,
        ),
      /invalid|stale/,
    );
  }
  for (const field of ["orderCount", "totalRemainingQuantity"]) {
    const x = appendFixture();
    x.append.level.firstOrder = PublicKey.default;
    x.append.tail.previousOrder = PublicKey.default;
    x.append.level.orderCount = new BN(2);
    x.append.level.totalRemainingQuantity = new BN(3);
    x.append.level[field] = new BN("18446744073709551615");
    assert.throws(
      () =>
        validatePredictionRestingOrder(
          x.market,
          x.book,
          x.position,
          "yes",
          "bid",
          new BN(600000),
          new BN(1),
          new BN(99),
          x.append,
        ),
      /counter limit/,
    );
  }
});

test("append IDL writes the old tail without requiring its owner's signature", async () => {
  const { Program, BN } = require("@anchor-lang/core");
  const { Connection, SystemProgram, Transaction } = require("@solana/web3.js");
  const idl = JSON.parse(
    readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
  );
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const market = new PublicKey(new Uint8Array(32).fill(3)),
    owner = new PublicKey(new Uint8Array(32).fill(4));
  const derive = (seed, ...keys) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(seed), ...keys],
      program.programId,
    )[0];
  for (const outcome of ["yes", "no"])
    for (const side of ["bid", "ask"]) {
      const price = new BN(600000),
        id = new BN(2),
        old = new BN(1);
      const tailOrder = derive(
        "prediction_order",
        market.toBuffer(),
        old.toArrayLike(Buffer, "le", 8),
      );
      const ix = await program.methods
        .appendPredictionOrder(
          id,
          { [outcome]: {} },
          { [side]: {} },
          price,
          new BN(3),
        )
        .accountsStrict({
          owner,
          market,
          position: derive(
            "prediction_position",
            market.toBuffer(),
            owner.toBuffer(),
          ),
          orderBook: derive("prediction_book", market.toBuffer()),
          priceLevel: derive(
            "prediction_level",
            market.toBuffer(),
            Buffer.from(outcome),
            Buffer.from(side),
            price.toArrayLike(Buffer, "le", 8),
          ),
          tailOrder,
          order: derive(
            "prediction_order",
            market.toBuffer(),
            id.toArrayLike(Buffer, "le", 8),
          ),
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const decoded = program.coder.instruction.decode(ix.data);
      assert.equal(decoded.name, "appendPredictionOrder");
      assert.equal(decoded.data.orderId.toString(), "2");
      assert.equal(decoded.data.quantity.toString(), "3");
      assert.equal(ix.keys.length, 8);
      assert.equal(ix.keys[0].isSigner, true);
      assert.equal(ix.keys[5].pubkey.toBase58(), tailOrder.toBase58());
      assert.equal(ix.keys[5].isSigner, false);
      assert.equal(ix.keys[5].isWritable, true);
      for (let i = 1; i < ix.keys.length; i++)
        assert.equal(ix.keys[i].isSigner, false);
      const tx = new Transaction({
        feePayer: owner,
        recentBlockhash: PublicKey.default.toBase58(),
      }).add(ix);
      assert.ok(
        tx.serialize({ requireAllSignatures: false, verifySignatures: false })
          .length <= 1232,
      );
    }
});

test("new-price routing finds best, middle and worst gaps for both outcomes and sides", async () => {
  const { BN } = require("@anchor-lang/core");
  for (const outcome of ["yes", "no"])
    for (const side of ["bid", "ask"]) {
      const x = appendFixture(outcome, side);
      const prices = side === "bid" ? [600000, 400000] : [600000, 800000];
      const levels = prices.map((price, i) => ({
        ...x.append.level,
        price: new BN(price),
        betterPrice: i ? new BN(prices[0]) : null,
        worsePrice: i ? null : new BN(prices[1]),
      }));
      const byAddress = new Map(
        levels.map((level) => [
          derivePredictionPriceLevelPda(
            x.book.market,
            outcome,
            side,
            level.price,
          ).toBase58(),
          level,
        ]),
      );
      const reader = {
        predictionPriceLevel: {
          fetchNullable: async (address) =>
            byAddress.get(address.toBase58()) ?? null,
        },
        predictionOrder: {
          fetchNullable: async () => {
            throw new Error("Insertion must not read queue tails");
          },
        },
      };
      const requested =
        side === "bid" ? [700000, 500000, 300000] : [500000, 700000, 900000];
      for (const [i, price] of requested.entries()) {
        const target = await readPredictionPlacementTarget(
          reader,
          x.book.market,
          x.book,
          outcome,
          side,
          new BN(price),
        );
        assert.equal(target.kind, "insert");
        assert.equal(
          target.better?.price.toNumber() ?? null,
          i === 0 ? null : prices[i - 1],
        );
        assert.equal(
          target.worse?.price.toNumber() ?? null,
          i === 2 ? null : prices[i],
        );
        const amount = validatePredictionRestingOrder(
          x.market,
          x.book,
          x.position,
          outcome,
          side,
          new BN(price),
          new BN(1),
          new BN(99),
          target,
        );
        assert.equal(amount.toNumber(), side === "bid" ? price : 1);
      }
      levels[1].betterPrice = null;
      await assert.rejects(
        () =>
          readPredictionPlacementTarget(
            reader,
            x.book.market,
            x.book,
            outcome,
            side,
            new BN(requested[1]),
          ),
        /invalid|changed/i,
      );
      levels[1].betterPrice = new BN(prices[0]);
      levels[0].worsePrice = new BN(prices[0]);
      await assert.rejects(
        () =>
          readPredictionPlacementTarget(
            reader,
            x.book.market,
            x.book,
            outcome,
            side,
            new BN(requested[2]),
          ),
        /ordering|cycle/i,
      );
    }
});

test("insertion preflight rejects stale adjacency, identities, empty levels and crossing", () => {
  const { BN } = require("@anchor-lang/core");
  const run = (x, target, price = 700000) =>
    validatePredictionRestingOrder(
      x.market,
      x.book,
      x.position,
      "yes",
      "bid",
      new BN(price),
      new BN(1),
      new BN(99),
      target,
    );
  for (const mutate of [
    (x, t) => {
      t.worse.market = PublicKey.default;
    },
    (x, t) => {
      t.worse.outcome = { no: {} };
    },
    (x, t) => {
      t.worse.side = { ask: {} };
    },
    (x, t) => {
      t.worse.firstOrder = null;
    },
    (x, t) => {
      t.worse.orderCount = new BN(0);
    },
    (x, t) => {
      t.worse.totalRemainingQuantity = new BN(0);
    },
    (x, t) => {
      t.worse.betterPrice = new BN(800000);
    },
    (x, t) => {
      t.worse = null;
    },
    (x, t) => {
      x.book.yesBestBid = null;
    },
  ]) {
    const x = appendFixture();
    const target = { kind: "insert", better: null, worse: x.append.level };
    mutate(x, target);
    assert.throws(() => run(x, target), /invalid|stale|occupied/i);
  }
  const x = appendFixture();
  const target = { kind: "insert", better: null, worse: x.append.level };
  x.book.yesBestAsk = new BN(700000);
  assert.throws(() => run(x, target), /cross/);
});

test("insertion neighbor discovery stops at its RPC bound and propagates failures", async () => {
  const { BN } = require("@anchor-lang/core");
  const x = appendFixture();
  const levels = new Map();
  for (let i = 0; i < 129; i++) {
    const price = new BN(600000 - i * 1000);
    levels.set(
      derivePredictionPriceLevelPda(
        x.book.market,
        "yes",
        "bid",
        price,
      ).toBase58(),
      {
        ...x.append.level,
        price,
        betterPrice: i === 0 ? null : price.addn(1000),
        worsePrice: price.subn(1000),
      },
    );
  }
  let reads = 0;
  const reader = {
    predictionPriceLevel: {
      fetchNullable: async (address) => {
        reads++;
        return levels.get(address.toBase58()) ?? null;
      },
    },
    predictionOrder: { fetchNullable: async () => null },
  };
  await assert.rejects(
    () =>
      readPredictionPlacementTarget(
        reader,
        x.book.market,
        x.book,
        "yes",
        "bid",
        new BN(10000),
      ),
    /128 levels/,
  );
  assert.equal(reads, 129); // Requested price plus at most 128 list accounts.
  reader.predictionPriceLevel.fetchNullable = async (address) => {
    if (address.equals(x.append.levelAddress))
      throw new Error("neighbor RPC failed");
    return null;
  };
  await assert.rejects(
    () =>
      readPredictionPlacementTarget(
        reader,
        x.book.market,
        x.book,
        "yes",
        "bid",
        new BN(500000),
      ),
    /neighbor RPC failed/,
  );
});

test("insertion IDL encodes optional neighbors and stays within packet limits", async () => {
  const { Program, BN } = require("@anchor-lang/core");
  const { Connection, SystemProgram, Transaction } = require("@solana/web3.js");
  const idl = JSON.parse(
    readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
  );
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const owner = new PublicKey(new Uint8Array(32).fill(5));
  const market = new PublicKey(new Uint8Array(32).fill(3));
  for (const [better, worse] of [
    [null, 600000],
    [800000, 600000],
    [800000, null],
  ]) {
    const level = (price) =>
      price === null
        ? null
        : derivePredictionPriceLevelPda(market, "yes", "bid", new BN(price));
    const ix = await program.methods
      .insertPredictionOrder(
        new BN(7),
        { yes: {} },
        { bid: {} },
        new BN(700000),
        new BN(2),
      )
      .accountsStrict({
        owner,
        market,
        position: derivePredictionPositionPda(market, owner),
        orderBook: derivePredictionBookPda(market),
        priceLevel: level(700000),
        order: derivePredictionOrderPda(market, new BN(7)),
        systemProgram: SystemProgram.programId,
        betterLevel: level(better) ?? program.programId,
        worseLevel: level(worse) ?? program.programId,
      })
      .instruction();
    assert.equal(
      program.coder.instruction.decode(ix.data).name,
      "insertPredictionOrder",
    );
    assert.equal(ix.keys[0].isSigner, true);
    assert.equal(
      ix.keys[7].pubkey.toBase58(),
      (level(better) ?? program.programId).toBase58(),
    );
    assert.equal(
      ix.keys[8].pubkey.toBase58(),
      (level(worse) ?? program.programId).toBase58(),
    );
    assert.equal(ix.keys[7].isWritable, better !== null);
    assert.equal(ix.keys[8].isWritable, worse !== null);
    const tx = new Transaction({
      feePayer: owner,
      recentBlockhash: PublicKey.default.toBase58(),
    }).add(ix);
    assert.ok(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false })
        .length <= 1232,
    );
  }
});

test("one-maker matching previews maker-price execution, fees and unposted quantity on both outcomes", async () => {
  const { BN } = require("@anchor-lang/core");
  for (const outcome of ["yes", "no"])
    for (const makerSide of ["bid", "ask"]) {
      const x = cancellationFixture(outcome, makerSide);
      x.book.nextOrderId = new BN(2);
      const side = makerSide === "bid" ? "ask" : "bid";
      const taker = new PublicKey(new Uint8Array(32).fill(9));
      x.position.owner = taker;
      for (const quantity of [1, 2, 10]) {
        const target = await readPredictionMatchTarget(
          x.reader,
          x.book.market,
          x.book,
          outcome,
          side,
          new BN(quantity),
        );
        const limit = new BN(side === "bid" ? 800000 : 400000);
        const plan = validatePredictionMatch(
          x.market,
          x.book,
          x.position,
          target,
          outcome,
          side,
          limit,
          new BN(quantity),
          100,
          taker,
          new BN(99),
        );
        const fill = Math.min(quantity, 2);
        assert.equal(plan.fill.toNumber(), fill);
        assert.equal(plan.notional.toNumber(), 600000 * fill);
        assert.equal(plan.fee.toNumber(), 6000 * fill);
        assert.equal(
          plan.cash.toNumber(),
          (side === "bid" ? 606000 : 594000) * fill,
        );
        assert.equal(plan.unfilled.toNumber(), quantity - fill);
        assert.equal(target.nextOrder, null);
        assert.equal(
          target.rentRecipient?.toBase58() ?? null,
          quantity >= 2 ? x.owner.toBase58() : null,
        );
      }
    }
  assert.equal(PREDICTION_MATCHING_ENABLED, false);
});

test("matching discovers only full-fill FIFO or empty-level removal accounts", async () => {
  const { BN } = require("@anchor-lang/core");
  const x = cancellationFixture("yes", "ask", 3);
  x.book.nextOrderId = new BN(4);
  const partial = await readPredictionMatchTarget(
    x.reader,
    x.book.market,
    x.book,
    "yes",
    "bid",
    new BN(1),
  );
  assert.equal(partial.nextOrder, null);
  const full = await readPredictionMatchTarget(
    x.reader,
    x.book.market,
    x.book,
    "yes",
    "bid",
    new BN(2),
  );
  assert.equal(full.nextOrder.toBase58(), x.address(2).toBase58());
  assert.equal(full.rentRecipient, null);
  assert.equal(full.worseLevel, null);
  x.orders.get(x.address(2).toBase58()).previousOrder = null;
  await assert.rejects(
    () =>
      readPredictionMatchTarget(
        x.reader,
        x.book.market,
        x.book,
        "yes",
        "bid",
        new BN(2),
      ),
    /successor/,
  );
  const y = cancellationFixture("no", "bid");
  y.book.nextOrderId = new BN(2);
  y.level.worsePrice = new BN(500000);
  const worse = derivePredictionPriceLevelPda(
    y.book.market,
    "no",
    "bid",
    new BN(500000),
  );
  y.levels.set(worse.toBase58(), {
    ...y.level,
    price: new BN(500000),
    betterPrice: new BN(600000),
    worsePrice: null,
  });
  const target = await readPredictionMatchTarget(
    y.reader,
    y.book.market,
    y.book,
    "no",
    "ask",
    new BN(2),
  );
  assert.equal(target.worseLevel.toBase58(), worse.toBase58());
  y.levels.get(worse.toBase58()).betterPrice = null;
  await assert.rejects(
    () =>
      readPredictionMatchTarget(
        y.reader,
        y.book.market,
        y.book,
        "no",
        "ask",
        new BN(2),
      ),
    /Next price level/,
  );
});

test("matching fails closed on missing books, bad heads, invalid amounts or RPC errors", async () => {
  const { BN } = require("@anchor-lang/core");
  for (const mutate of [
    (x) => {
      x.book.yesBestAsk = null;
    },
    (x) => {
      x.level.betterPrice = new BN(500000);
    },
    (x) => {
      x.level.firstOrder = null;
    },
    (x) => {
      x.level.totalRemainingQuantity = new BN(3);
    },
    (x) => {
      x.orders.get(x.address(1).toBase58()).previousOrder = x.address(2);
    },
    (x) => {
      x.orders.get(x.address(1).toBase58()).status = { filled: {} };
    },
    (x) => {
      x.orders.clear();
    },
    (x) => {
      x.levels.clear();
    },
  ]) {
    const x = cancellationFixture("yes", "ask");
    x.book.nextOrderId = new BN(2);
    mutate(x);
    await assert.rejects(
      () =>
        readPredictionMatchTarget(
          x.reader,
          x.book.market,
          x.book,
          "yes",
          "bid",
          new BN(1),
        ),
      /No sell|invalid|changed/i,
    );
  }
  const x = cancellationFixture("yes", "ask");
  x.book.nextOrderId = new BN(2);
  await assert.rejects(
    () =>
      readPredictionMatchTarget(
        x.reader,
        x.book.market,
        x.book,
        "yes",
        "bid",
        new BN(0),
      ),
    /positive/,
  );
  x.reader.predictionPriceLevel.fetchNullable = async () => {
    throw new Error("RPC failed");
  };
  await assert.rejects(
    () =>
      readPredictionMatchTarget(
        x.reader,
        x.book.market,
        x.book,
        "yes",
        "bid",
        new BN(1),
      ),
    /RPC failed/,
  );
});

test("matching preflight rejects self trades, closed time, noncrossing prices, funds and arithmetic limits", async () => {
  const { BN } = require("@anchor-lang/core");
  for (const mutation of [
    "self",
    "time",
    "limit",
    "funds",
    "overflow",
    "fee",
    "backing",
    "identity",
  ]) {
    const x = cancellationFixture("yes", "ask");
    x.book.nextOrderId = new BN(2);
    const taker = new PublicKey(new Uint8Array(32).fill(9));
    x.position.owner = taker;
    const target = await readPredictionMatchTarget(
      x.reader,
      x.book.market,
      x.book,
      "yes",
      "bid",
      new BN(1),
    );
    let limit = new BN(700000),
      now = new BN(99),
      fee = 100;
    if (mutation === "self") target.maker.owner = taker;
    if (mutation === "time") now = new BN(100);
    if (mutation === "limit") limit = new BN(500000);
    if (mutation === "funds") x.position.collateralFree = new BN(600000);
    if (mutation === "overflow")
      x.position.yesFree = new BN("18446744073709551615");
    if (mutation === "fee") fee = 1001;
    if (mutation === "backing") target.maker.lockedCollateral = new BN(99);
    if (mutation === "identity") target.makerAddress = PublicKey.default;
    assert.throws(() =>
      validatePredictionMatch(
        x.market,
        x.book,
        x.position,
        target,
        "yes",
        "bid",
        limit,
        new BN(1),
        fee,
        taker,
        now,
      ),
    );
  }
});

test("matching fee previews round upward even when a tiny seller receives zero net collateral", async () => {
  const { BN } = require("@anchor-lang/core");
  for (const makerSide of ["bid", "ask"]) {
    const x = cancellationFixture("yes", makerSide);
    x.book.nextOrderId = new BN(2);
    const old = x.append.levelAddress.toBase58();
    x.levels.delete(old);
    const levelAddress = derivePredictionPriceLevelPda(
      x.book.market,
      "yes",
      makerSide,
      new BN(1),
    );
    x.level.price = new BN(1);
    x.levels.set(levelAddress.toBase58(), x.level);
    x.book[makerSide === "bid" ? "yesBestBid" : "yesBestAsk"] = new BN(1);
    const maker = x.orders.get(x.address(1).toBase58());
    maker.price = new BN(1);
    maker.priceLevel = levelAddress;
    maker.lockedCollateral = new BN(2);
    x.market.priceTick = new BN(1);
    const taker = new PublicKey(new Uint8Array(32).fill(9));
    x.position.owner = taker;
    const side = makerSide === "bid" ? "ask" : "bid";
    const target = await readPredictionMatchTarget(
      x.reader,
      x.book.market,
      x.book,
      "yes",
      side,
      new BN(1),
    );
    const plan = validatePredictionMatch(
      x.market,
      x.book,
      x.position,
      target,
      "yes",
      side,
      new BN(1),
      new BN(1),
      1,
      taker,
      new BN(99),
    );
    assert.equal(plan.fee.toNumber(), 1);
    assert.equal(plan.cash.toNumber(), side === "bid" ? 2 : 0);
  }
});

test("matching IDL encodes one taker signature, optional removal accounts and a bounded packet", async () => {
  const { Program, BN } = require("@anchor-lang/core");
  const { Connection, Transaction } = require("@solana/web3.js");
  const idl = JSON.parse(
    readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
  );
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const names = [
    "taker",
    "market",
    "orderBook",
    "protocolConfig",
    "marketFees",
    "makerOrder",
    "priceLevel",
    "makerPosition",
    "takerPosition",
    "nextOrder",
    "worseLevel",
    "levelRentRecipient",
  ];
  for (const optional of [false, true]) {
    const accounts = Object.fromEntries(
      names.map((name, i) => [
        name,
        i >= 9 && !optional
          ? program.programId
          : new PublicKey(new Uint8Array(32).fill(i + 1)),
      ]),
    );
    const ix = await program.methods
      .matchPredictionOrder(
        { no: {} },
        { bid: {} },
        new BN(600000),
        new BN("9007199254740993"),
      )
      .accountsStrict(accounts)
      .instruction();
    const decoded = program.coder.instruction.decode(ix.data);
    assert.equal(decoded.name, "matchPredictionOrder");
    assert.equal(decoded.data.quantity.toString(), "9007199254740993");
    assert.equal(ix.keys.filter((k) => k.isSigner).length, 1);
    assert.equal(ix.keys[3].isWritable, false);
    assert.equal(ix.keys[4].isWritable, true);
    for (let i = 9; i < 12; i++) assert.equal(ix.keys[i].isWritable, optional);
    const tx = new Transaction({
      feePayer: accounts.taker,
      recentBlockhash: PublicKey.default.toBase58(),
    }).add(ix);
    assert.ok(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false })
        .length <= 1232,
    );
  }
});

function cancellationFixture(outcome = "yes", side = "bid", size = 1) {
  const { BN } = require("@anchor-lang/core");
  const x = appendFixture(outcome, side);
  const owner = x.append.tail.owner;
  const address = (id) => derivePredictionOrderPda(x.book.market, new BN(id));
  const orders = new Map();
  for (let id = 1; id <= size; id++)
    orders.set(address(id).toBase58(), {
      ...x.append.tail,
      orderId: new BN(id),
      previousOrder: id === 1 ? null : address(id - 1),
      nextOrder: id === size ? null : address(id + 1),
    });
  const level = {
    ...x.append.level,
    firstOrder: address(1),
    lastOrder: address(size),
    orderCount: new BN(size),
    totalRemainingQuantity: new BN(2 * size),
    rentPayer: owner,
  };
  const levels = new Map([[x.append.levelAddress.toBase58(), level]]);
  const reader = {
    predictionOrder: {
      fetchNullable: async (key) => orders.get(key.toBase58()) ?? null,
    },
    predictionPriceLevel: {
      fetchNullable: async (key) => levels.get(key.toBase58()) ?? null,
    },
  };
  return { ...x, owner, address, orders, levels, level, reader };
}

test("cancellation selects exact FIFO neighbors and omits price accounts for surviving levels", async () => {
  for (const outcome of ["yes", "no"])
    for (const side of ["bid", "ask"]) {
      const x = cancellationFixture(outcome, side, 3);
      for (const id of [1, 2, 3]) {
        const accounts = await readPredictionCancellationAccounts(
          x.reader,
          x.book.market,
          x.owner,
          x.address(id),
        );
        assert.equal(
          accounts.previousOrder.toBase58(),
          (id === 1 ? PublicKey.default : x.address(id - 1)).toBase58(),
        );
        assert.equal(
          accounts.nextOrder.toBase58(),
          (id === 3 ? PublicKey.default : x.address(id + 1)).toBase58(),
        );
        for (const field of ["betterLevel", "worseLevel", "levelRentRecipient"])
          assert.equal(
            accounts[field].toBase58(),
            PublicKey.default.toBase58(),
          );
        assert.equal(
          accounts.position.toBase58(),
          derivePredictionPositionPda(x.book.market, x.owner).toBase58(),
        );
        assert.equal(
          accounts.orderBook.toBase58(),
          derivePredictionBookPda(x.book.market).toBase58(),
        );
      }
    }
  assert.equal(PREDICTION_CANCELLATION_ENABLED, false);
});

test("turning off order entry or funding never turns off deployed cancellation", () => {
  function flags(env) {
    const loaded = { exports: {} };
    runInNewContext(code, {
      module: loaded,
      exports: loaded.exports,
      Buffer,
      TextEncoder,
      TextDecoder,
      crypto: webcrypto,
      process: { env },
      require: (specifier) =>
        specifier === "./solana"
          ? { PROGRAM_ID: PublicKey.default }
          : require(specifier),
    });
    return loaded.exports;
  }
  const draft = {
    NEXT_PUBLIC_PREDICTION_DRAFTS_ENABLED: "true",
    NEXT_PUBLIC_PREDICTION_CANCELLATION_ENABLED: "true",
  };
  const exitsOnly = flags(draft);
  assert.equal(exitsOnly.PREDICTION_CANCELLATION_ENABLED, true);
  assert.equal(exitsOnly.PREDICTION_ORDERS_ENABLED, false);
  assert.equal(exitsOnly.PREDICTION_MATCHING_ENABLED, false);
  const localTrading = {
    ...draft,
    NEXT_PUBLIC_PREDICTION_FUNDING_ENABLED: "true",
    NEXT_PUBLIC_PREDICTION_ORDERS_ENABLED: "true",
  };
  assert.equal(flags(localTrading).PREDICTION_ORDERS_ENABLED, true);
  localTrading.NEXT_PUBLIC_PREDICTION_MATCHING_ENABLED = "true";
  localTrading.NEXT_PUBLIC_PREDICTION_ORDERS_ENABLED = "false";
  assert.equal(flags(localTrading).PREDICTION_MATCHING_ENABLED, true);
  assert.equal(flags(localTrading).PREDICTION_ORDERS_ENABLED, false);
  localTrading.NEXT_PUBLIC_PREDICTION_ORDERS_ENABLED = "true";
  localTrading.NEXT_PUBLIC_PREDICTION_CANCELLATION_ENABLED = "false";
  assert.equal(flags(localTrading).PREDICTION_ORDERS_ENABLED, false);
  assert.equal(flags(localTrading).PREDICTION_CANCELLATION_ENABLED, false);
  assert.equal(flags(localTrading).PREDICTION_MATCHING_ENABLED, false);
});

test("final-order cancellation discovers reciprocal price neighbors and preserves the rent payer", async () => {
  const { BN } = require("@anchor-lang/core");
  for (const outcome of ["yes", "no"])
    for (const side of ["bid", "ask"]) {
      for (const shape of ["only", "best", "middle", "worst"]) {
        const x = cancellationFixture(outcome, side);
        const better = new BN(side === "bid" ? 800000 : 400000);
        const worse = new BN(side === "bid" ? 400000 : 800000);
        const rentPayer = new PublicKey(new Uint8Array(32).fill(7));
        x.level.rentPayer = rentPayer;
        const address = (price) =>
          derivePredictionPriceLevelPda(x.book.market, outcome, side, price);
        if (shape === "middle" || shape === "worst") {
          x.level.betterPrice = better;
          x.levels.set(address(better).toBase58(), {
            ...x.level,
            price: better,
            betterPrice: null,
            worsePrice: x.level.price,
          });
        }
        if (shape === "middle" || shape === "best") {
          x.level.worsePrice = worse;
          x.levels.set(address(worse).toBase58(), {
            ...x.level,
            price: worse,
            betterPrice: x.level.price,
            worsePrice: null,
          });
        }
        const result = await readPredictionCancellationAccounts(
          x.reader,
          x.book.market,
          x.owner,
          x.address(1),
        );
        assert.equal(
          result.levelRentRecipient.toBase58(),
          rentPayer.toBase58(),
        );
        assert.equal(
          result.betterLevel.toBase58(),
          (x.level.betterPrice
            ? address(better)
            : PublicKey.default
          ).toBase58(),
        );
        assert.equal(
          result.worseLevel.toBase58(),
          (x.level.worsePrice ? address(worse) : PublicKey.default).toBase58(),
        );
      }
    }
});

test("cancellation rejects foreign owners, closed orders, bad backing and broken FIFO endpoints", async () => {
  const { BN } = require("@anchor-lang/core");
  for (const mutate of [
    (x) => {
      x.orders.get(x.address(1).toBase58()).owner = PublicKey.default;
    },
    (x) => {
      x.orders.get(x.address(1).toBase58()).market = PublicKey.default;
    },
    (x) => {
      x.orders.get(x.address(1).toBase58()).status = { canceled: {} };
    },
    (x) => {
      x.orders.get(x.address(1).toBase58()).status = { filled: {} };
    },
    (x) => {
      x.orders.get(x.address(1).toBase58()).lockedCollateral = new BN(1);
    },
    (x) => {
      x.orders.get(x.address(1).toBase58()).remainingQuantity = new BN(0);
    },
    (x) => {
      x.orders.get(x.address(1).toBase58()).previousOrder = x.address(1);
    },
    (x) => {
      x.level.firstOrder = null;
    },
    (x) => {
      x.level.orderCount = new BN(2);
    },
    (x) => {
      x.level.totalRemainingQuantity = new BN(3);
    },
    (x) => {
      x.levels.clear();
    },
    (x) => {
      x.orders.clear();
    },
  ]) {
    const x = cancellationFixture();
    mutate(x);
    await assert.rejects(
      () =>
        readPredictionCancellationAccounts(
          x.reader,
          x.book.market,
          x.owner,
          x.address(1),
        ),
      /unavailable|open orders|backing|endpoints|totals/i,
    );
  }
  const x = cancellationFixture("yes", "bid", 3);
  x.orders.get(x.address(1).toBase58()).nextOrder = null;
  await assert.rejects(
    () =>
      readPredictionCancellationAccounts(
        x.reader,
        x.book.market,
        x.owner,
        x.address(2),
      ),
    /neighbors/,
  );
  x.orders.delete(x.address(1).toBase58());
  await assert.rejects(
    () =>
      readPredictionCancellationAccounts(
        x.reader,
        x.book.market,
        x.owner,
        x.address(2),
      ),
    /neighbors/,
  );
});

test("cancellation never guesses neighbors on missing accounts or RPC failures", async () => {
  const { BN } = require("@anchor-lang/core");
  const x = cancellationFixture();
  x.level.betterPrice = new BN(800000);
  await assert.rejects(
    () =>
      readPredictionCancellationAccounts(
        x.reader,
        x.book.market,
        x.owner,
        x.address(1),
      ),
    /Price neighbors/,
  );
  x.reader.predictionPriceLevel.fetchNullable = async () => {
    throw new Error("RPC unavailable");
  };
  await assert.rejects(
    () =>
      readPredictionCancellationAccounts(
        x.reader,
        x.book.market,
        x.owner,
        x.address(1),
      ),
    /RPC unavailable/,
  );
});

test("cancellation IDL requires only the owner signature and fits the maximum account set", async () => {
  const { Program, BN } = require("@anchor-lang/core");
  const { Connection, Transaction } = require("@solana/web3.js");
  const idl = JSON.parse(
    readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
  );
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const keys = Array.from(
    { length: 11 },
    (_, i) => new PublicKey(new Uint8Array(32).fill(i + 1)),
  );
  const names = [
    "owner",
    "market",
    "position",
    "orderBook",
    "order",
    "priceLevel",
    "previousOrder",
    "nextOrder",
    "betterLevel",
    "worseLevel",
    "levelRentRecipient",
  ];
  for (const optional of [true, false]) {
    const accounts = Object.fromEntries(
      names.map((name, i) => [
        name,
        i >= 6 && !optional ? program.programId : keys[i],
      ]),
    );
    const ix = await program.methods
      .cancelPredictionOrder(new BN("18446744073709551614"))
      .accountsStrict(accounts)
      .instruction();
    const decoded = program.coder.instruction.decode(ix.data);
    assert.equal(decoded.name, "cancelPredictionOrder");
    assert.equal(decoded.data.orderId.toString(), "18446744073709551614");
    assert.equal(ix.keys.filter((key) => key.isSigner).length, 1);
    assert.equal(ix.keys[0].pubkey.toBase58(), keys[0].toBase58());
    for (let i = 6; i < 11; i++) assert.equal(ix.keys[i].isWritable, optional);
    const tx = new Transaction({
      feePayer: keys[0],
      recentBlockhash: PublicKey.default.toBase58(),
    }).add(ix);
    assert.ok(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false })
        .length <= 1232,
    );
  }
});

test("placement routing reads actual levels and tails and never falls back on RPC failure", async () => {
  const { BN } = require("@anchor-lang/core");
  const x = appendFixture();
  const { book } = x;
  const readers = {
    predictionPriceLevel: {
      fetchNullable: async (address) => {
        assert.equal(address.toBase58(), x.append.levelAddress.toBase58());
        return x.append.level;
      },
    },
    predictionOrder: {
      fetchNullable: async (address) => {
        assert.equal(address.toBase58(), x.append.tailAddress.toBase58());
        return x.append.tail;
      },
    },
  };
  const selected = await readPredictionPlacementTarget(
    readers,
    book.market,
    book,
    "yes",
    "bid",
    new BN(600000),
  );
  assert.equal(selected.kind, "append");
  assert.equal(
    selected.tailAddress.toBase58(),
    x.append.tailAddress.toBase58(),
  );
  readers.predictionPriceLevel.fetchNullable = async () => null;
  await assert.rejects(
    () =>
      readPredictionPlacementTarget(
        readers,
        book.market,
        book,
        "yes",
        "bid",
        new BN(600000),
      ),
    /Price list changed or is invalid/,
  );
  book.yesBestBid = null;
  assert.equal(
    (
      await readPredictionPlacementTarget(
        readers,
        book.market,
        book,
        "yes",
        "bid",
        new BN(600000),
      )
    ).kind,
    "place",
  );
  readers.predictionPriceLevel.fetchNullable = async () => {
    throw new Error("RPC unavailable");
  };
  await assert.rejects(
    () =>
      readPredictionPlacementTarget(
        readers,
        book.market,
        book,
        "yes",
        "bid",
        new BN(600000),
      ),
    /RPC unavailable/,
  );
  readers.predictionPriceLevel.fetchNullable = async () => x.append.level;
  readers.predictionOrder.fetchNullable = async () => null;
  await assert.rejects(
    () =>
      readPredictionPlacementTarget(
        readers,
        book.market,
        book,
        "yes",
        "bid",
        new BN(600000),
      ),
    /tail account is unavailable/,
  );
  x.append.level.lastOrder = null;
  await assert.rejects(
    () =>
      readPredictionPlacementTarget(
        readers,
        book.market,
        book,
        "yes",
        "bid",
        new BN(600000),
      ),
    /no queue tail/,
  );
});

test("deposit preflight rejects zero, unavailable balance, overspending and u64 overflow", () => {
  const { BN } = require("@anchor-lang/core");
  const amount = new BN("10000000");
  assert.equal(
    validatePredictionDepositAmount(
      amount,
      new BN("20000000"),
      new BN(0),
    ).toString(),
    "10000000",
  );
  assert.throws(
    () => validatePredictionDepositAmount(new BN(0), amount, new BN(0)),
    /positive u64/,
  );
  assert.throws(
    () => validatePredictionDepositAmount(new BN(-1), amount, new BN(0)),
    /positive u64/,
  );
  assert.throws(
    () => validatePredictionDepositAmount(amount, null, new BN(0)),
    /unavailable/,
  );
  assert.throws(
    () => validatePredictionDepositAmount(amount, new BN(0), new BN(0)),
    /wallet collateral balance/,
  );
  const maximum = new BN("18446744073709551615");
  assert.throws(
    () =>
      validatePredictionDepositAmount(
        maximum.addn(1),
        maximum.addn(1),
        new BN(0),
      ),
    /positive u64/,
  );
  assert.throws(
    () => validatePredictionDepositAmount(new BN(1), new BN(1), maximum),
    /position balance limit/,
  );
  assert.equal(
    validatePredictionDepositAmount(maximum, maximum, new BN(0)).toString(),
    maximum.toString(),
  );
  assert.equal(PREDICTION_FUNDING_ENABLED, false);
});

test("withdrawal preflight uses only free cash and rejects zero and oversized amounts", () => {
  const { BN } = require("@anchor-lang/core");
  const free = new BN("1000000");
  assert.equal(
    validatePredictionWithdrawalAmount(free, free).toString(),
    "1000000",
  );
  for (const amount of [
    new BN(0),
    new BN(-1),
    new BN("18446744073709551616"),
  ]) {
    assert.throws(
      () => validatePredictionWithdrawalAmount(amount, free),
      /positive u64/,
    );
  }
  assert.throws(
    () => validatePredictionWithdrawalAmount(new BN(1), new BN(0)),
    /available collateral/,
  );
  assert.throws(
    () => validatePredictionWithdrawalAmount(free.addn(1), free),
    /available collateral/,
  );
});

test("opening preflight requires the active-admin creator, Draft status and exclusive close time", () => {
  const { BN } = require("@anchor-lang/core");
  const authority = new PublicKey(new Uint8Array(32).fill(3));
  const stranger = new PublicKey(new Uint8Array(32).fill(4));
  const market = {
    authority,
    resolver: authority,
    status: { draft: {} },
    closeTs: new BN(100),
  };
  assert.equal(
    predictionOpeningIssue(market, authority, new BN(99), true),
    null,
  );
  assert.match(
    predictionOpeningIssue(market, authority, new BN(99), false),
    /active administrator/,
  );
  market.resolver = stranger;
  assert.match(
    predictionOpeningIssue(market, authority, new BN(99), true),
    /primary outcome resolver/,
  );
  market.resolver = authority;
  for (const now of [100, 101]) {
    assert.match(
      predictionOpeningIssue(market, authority, new BN(now), true),
      /close time/,
    );
  }
  assert.match(
    predictionOpeningIssue(market, stranger, new BN(99), true),
    /authority/,
  );
  for (const status of ["open", "frozen", "proposed", "resolved"]) {
    market.status = { [status]: {} };
    assert.match(
      predictionOpeningIssue(market, authority, new BN(99), true),
      /draft/,
    );
  }
  // Draft creation alone must not expose an unsupported opening instruction.
  assert.equal(PREDICTION_OPENING_ENABLED, false);
});

test("rule files must appoint the creator as primary resolver", () => {
  const creator = new PublicKey(new Uint8Array(32).fill(3));
  const stranger = new PublicKey(new Uint8Array(32).fill(4));
  assert.doesNotThrow(() =>
    validatePredictionCreatorResolver(creator, creator),
  );
  assert.throws(
    () => validatePredictionCreatorResolver(stranger, creator),
    /primaryResolver.*creator/,
  );
});

test("opening IDL requires the authority signature, writable market and canonical admin record", async () => {
  const { Program } = require("@anchor-lang/core");
  const { Connection } = require("@solana/web3.js");
  const idl = JSON.parse(
    readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
  );
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const authority = new PublicKey(new Uint8Array(32).fill(3));
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("prediction_market"), Buffer.alloc(32, 7)],
    program.programId,
  )[0];
  const ix = await program.methods
    .openPredictionMarket()
    .accountsStrict({
      authority,
      market,
      adminRecord: PublicKey.findProgramAddressSync(
        [Buffer.from("admin"), authority.toBuffer()],
        program.programId,
      )[0],
    })
    .instruction();
  assert.equal(ix.data.length, 8); // No rule updates, amounts or new timestamps.
  const decoded = program.coder.instruction.decode(ix.data);
  assert.equal(decoded.name, "openPredictionMarket");
  assert.deepEqual(decoded.data, {});
  assert.equal(ix.keys.length, 3);
  assert.equal(ix.keys[0].pubkey.toBase58(), authority.toBase58());
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[0].isWritable, false);
  assert.equal(ix.keys[1].pubkey.toBase58(), market.toBase58());
  assert.equal(ix.keys[1].isSigner, false);
  assert.equal(ix.keys[1].isWritable, true);
  assert.equal(
    ix.keys[2].pubkey.toBase58(),
    PublicKey.findProgramAddressSync(
      [Buffer.from("admin"), authority.toBuffer()],
      program.programId,
    )[0].toBase58(),
  );
  assert.equal(ix.keys[2].isSigner, false);
  assert.equal(ix.keys[2].isWritable, false);
});

function completeSetFixture() {
  const { BN } = require("@anchor-lang/core");
  return {
    position: {
      collateralFree: new BN("10000000"),
      yesFree: new BN(3),
      noFree: new BN(3),
      collateralLocked: new BN("5000000"),
      yesLocked: new BN(10),
      noLocked: new BN(10),
    },
    market: {
      status: { open: {} },
      closeTs: new BN(100),
      payoutPerContract: new BN("1000000"),
      yesSupply: new BN(13),
      noSupply: new BN(13),
      backingReserve: new BN("13000000"),
    },
  };
}

test("complete-set preflight enforces time, free pairs and exact collateral arithmetic", () => {
  const { BN } = require("@anchor-lang/core");
  const { position, market } = completeSetFixture();
  const run = (quantity, action, now = 99) =>
    validatePredictionCompleteSet(
      new BN(quantity),
      position,
      market,
      action,
      new BN(now),
    );
  assert.equal(run(3, "split").toString(), "3000000");
  assert.equal(run(3, "merge", 100).toString(), "3000000");
  assert.throws(() => run(1, "split", 100), /before its close/);
  assert.throws(() => run(11, "split"), /available collateral/);
  assert.throws(() => run(4, "merge"), /available YES and NO/);
  for (const action of ["split", "merge"]) {
    for (const q of ["0", "-1", "18446744073709551616"])
      assert.throws(() => run(q, action), /positive whole/);
  }
  for (const status of ["draft", "frozen", "proposed", "resolved"]) {
    market.status = { [status]: {} };
    assert.throws(() => run(1, "split"), /open market/);
    if (["frozen", "proposed"].includes(status))
      assert.equal(run(1, "merge").toString(), "1000000");
    else assert.throws(() => run(1, "merge"), /Merging requires/);
  }
});

test("complete-set preflight checks all supply and reserve overflow or underflow", () => {
  const { BN } = require("@anchor-lang/core");
  const maximum = new BN("18446744073709551615");
  for (const field of [
    "yesFree",
    "noFree",
    "yesSupply",
    "noSupply",
    "backingReserve",
  ]) {
    const { position, market } = completeSetFixture();
    (field.endsWith("Free") ? position : market)[field] = maximum;
    assert.throws(
      () =>
        validatePredictionCompleteSet(
          new BN(1),
          position,
          market,
          "split",
          new BN(99),
        ),
      /limit/,
    );
  }
  for (const field of ["yesSupply", "noSupply", "backingReserve"]) {
    const { position, market } = completeSetFixture();
    market[field] = new BN(0);
    assert.throws(
      () =>
        validatePredictionCompleteSet(
          new BN(1),
          position,
          market,
          "merge",
          new BN(99),
        ),
      /backing/,
    );
  }
  for (const action of ["split", "merge"]) {
    const { position, market } = completeSetFixture();
    market.payoutPerContract = maximum;
    assert.throws(
      () =>
        validatePredictionCompleteSet(
          new BN(2),
          position,
          market,
          action,
          new BN(99),
        ),
      /exceeds u64/,
    );
  }
  const { position, market } = completeSetFixture();
  position.collateralFree = maximum;
  assert.throws(
    () =>
      validatePredictionCompleteSet(
        new BN(1),
        position,
        market,
        "merge",
        new BN(99),
      ),
    /collateral limit/,
  );
});

test("withdrawal and complete-set IDL agree with wallet account roles and units", async () => {
  const { Program, BN } = require("@anchor-lang/core");
  const { Connection, Keypair } = require("@solana/web3.js");
  const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
  } = require("@solana/spl-token");
  const idl = JSON.parse(
    readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
  );
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const owner = Keypair.generate().publicKey;
  const market = new PublicKey(new Uint8Array(32).fill(3));
  const mint = new PublicKey(new Uint8Array(32).fill(5));
  const derive = (seed, ...keys) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(seed), ...keys],
      program.programId,
    )[0];
  const position = derive(
    "prediction_position",
    market.toBuffer(),
    owner.toBuffer(),
  );
  const destination = getAssociatedTokenAddressSync(mint, owner);
  const ata = createAssociatedTokenAccountIdempotentInstruction(
    owner,
    destination,
    owner,
    mint,
  );
  assert.equal(ata.data[0], 1); // Safe if the ATA exists or is created concurrently.
  assert.equal(ata.keys[1].pubkey.toBase58(), destination.toBase58());
  const ix = await program.methods
    .withdrawPredictionCollateral(new BN("10000000"))
    .accountsStrict({
      owner,
      market,
      position,
      collateralMint: mint,
      destination,
      vaultAuthority: derive("vault-authority", market.toBuffer()),
      collateralVault: derive("vault", market.toBuffer(), mint.toBuffer()),
      tokenProgram: new PublicKey(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      ),
    })
    .instruction();
  assert.equal(
    program.coder.instruction.decode(ix.data).data.amount.toString(),
    "10000000",
  );
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[1].isWritable, false);
  assert.equal(ix.keys[2].isWritable, true);
  assert.equal(ix.keys[4].pubkey.toBase58(), destination.toBase58());
  assert.equal(ix.keys[4].isWritable, true);
  assert.equal(ix.keys[6].isWritable, true);
  for (const action of [
    "splitPredictionCompleteSet",
    "mergePredictionCompleteSet",
  ]) {
    const ix = await program.methods[action](new BN(3))
      .accountsStrict({ owner, market, position })
      .instruction();
    assert.equal(ix.keys.length, 3); // Ledger conversion: no token CPI or mint.
    assert.equal(ix.keys[0].isSigner, true);
    assert.equal(ix.keys[1].isWritable, true);
    assert.equal(ix.keys[2].isWritable, true);
    const decoded = program.coder.instruction.decode(ix.data);
    assert.equal(decoded.name, action);
    assert.equal(decoded.data.quantity.toString(), "3");
  }
});

test("deposit arguments encode exact collateral atoms and canonical account roles", async () => {
  const { Program, BN } = require("@anchor-lang/core");
  const { Connection } = require("@solana/web3.js");
  const idl = JSON.parse(
    readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
  );
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const owner = new PublicKey(new Uint8Array(32).fill(4));
  const market = new PublicKey(new Uint8Array(32).fill(3));
  const mint = new PublicKey(new Uint8Array(32).fill(5));
  const source = new PublicKey(new Uint8Array(32).fill(6));
  const derive = (seed, ...keys) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(seed), ...keys],
      program.programId,
    )[0];
  const vault = derive("vault", market.toBuffer(), mint.toBuffer());
  const ix = await program.methods
    .depositPredictionCollateral(new BN("10000000"))
    .accountsStrict({
      owner,
      market,
      position: derive(
        "prediction_position",
        market.toBuffer(),
        owner.toBuffer(),
      ),
      collateralMint: mint,
      source,
      vaultAuthority: derive("vault-authority", market.toBuffer()),
      collateralVault: vault,
      tokenProgram: new PublicKey(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      ),
    })
    .instruction();
  const decoded = program.coder.instruction.decode(ix.data);
  assert.equal(decoded.name, "depositPredictionCollateral");
  assert.equal(decoded.data.amount.toString(), "10000000");
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[1].isWritable, false);
  assert.equal(ix.keys[2].isWritable, true);
  assert.equal(ix.keys[4].pubkey.toBase58(), source.toBase58());
  assert.equal(ix.keys[4].isWritable, true);
  assert.equal(ix.keys[6].pubkey.toBase58(), vault.toBase58());
  assert.equal(ix.keys[6].isWritable, true);
});

test("position instruction and all six balance buckets agree with the IDL", async () => {
  const { Program, BN } = require("@anchor-lang/core");
  const { Connection, SystemProgram } = require("@solana/web3.js");
  const idl = JSON.parse(
    readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
  );
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const owner = new PublicKey(new Uint8Array(32).fill(4));
  const market = new PublicKey(new Uint8Array(32).fill(3));
  const position = PublicKey.findProgramAddressSync(
    [Buffer.from("prediction_position"), market.toBuffer(), owner.toBuffer()],
    program.programId,
  )[0];
  const ix = await program.methods
    .initializePredictionPosition()
    .accountsStrict({
      owner,
      market,
      position,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  assert.equal(
    program.coder.instruction.decode(ix.data).name,
    "initializePredictionPosition",
  );
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[1].isWritable, false);
  assert.equal(ix.keys[2].pubkey.toBase58(), position.toBase58());
  const fields = [
    "collateralFree",
    "collateralLocked",
    "yesFree",
    "yesLocked",
    "noFree",
    "noLocked",
  ];
  const ledger = { market, owner, bump: 254 };
  for (const [i, field] of fields.entries())
    ledger[field] = new BN(String((i + 1) * 11));
  const encoded = await program.coder.accounts.encode(
    "predictionPosition",
    ledger,
  );
  assert.equal(encoded.length, 121);
  const decoded = program.coder.accounts.decode("predictionPosition", encoded);
  assert.equal(decoded.market.toBase58(), market.toBase58());
  assert.equal(decoded.owner.toBase58(), owner.toBase58());
  for (const field of fields)
    assert.equal(decoded[field].toString(), ledger[field].toString());
});

test("creation arguments encode against the checked-in IDL within transaction limits", async () => {
  const { Program, BN } = require("@anchor-lang/core");
  const { Connection, SystemProgram, Transaction } = require("@solana/web3.js");
  const idl = JSON.parse(
    readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
  );
  // Every account is supplied explicitly; building this instruction needs no RPC.
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const parsed = await parsePredictionRules(bytes(rules()));
  const authority = parsed.resolver;
  const marketId = new Uint8Array(32).fill(7);
  const derive = (seed, ...keys) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(seed), ...keys],
      program.programId,
    )[0];
  const market = derive("prediction_market", Buffer.from(marketId));
  const mint = new PublicKey(new Uint8Array(32).fill(3));
  const instruction = await program.methods
    .initializePredictionMarket(
      Array.from(marketId),
      {
        resolver: authority,
        fallback: {
          resolver: mint,
          availableTs: new BN("1900086400"),
          deadlineTs: new BN("1900172800"),
        },
        closeTs: parsed.closeTs,
        earliestResolutionTs: new BN("1900003600"),
        resolutionDelaySeconds: parsed.resolutionDelaySeconds,
        payoutPerContract: new BN("1000000"),
        priceTick: new BN("10000"),
        rulesUri: `ar://${"a".repeat(195)}`,
        questionHash: parsed.questionHash,
        rulesHash: parsed.rulesHash,
      },
      "x".repeat(64),
      "X".repeat(16),
    )
    .accountsStrict({
      authority,
      adminRecord: derive("admin", authority.toBuffer()),
      market,
      collateralMint: mint,
      vaultAuthority: derive("vault-authority", market.toBuffer()),
      collateralVault: derive("vault", market.toBuffer(), mint.toBuffer()),
      marketMetadata: derive("market_metadata", market.toBuffer()),
      marketFees: derive("market_fees", market.toBuffer()),
      orderBook: derive("prediction_book", market.toBuffer()),
      tokenProgram: new PublicKey(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      ),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  assert.equal(
    program.coder.instruction.decode(instruction.data).name,
    "initializePredictionMarket",
  );
  assert.equal(
    instruction.keys[8].pubkey.toBase58(),
    derive("prediction_book", market.toBuffer()).toBase58(),
  );
  assert.equal(instruction.keys[8].isWritable, true);
  assert.equal(instruction.keys[8].isSigner, false);
  const tx = new Transaction({
    feePayer: authority,
    recentBlockhash: PublicKey.default.toBase58(),
  }).add(instruction);
  assert.ok(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false })
      .length <= 1232,
  );
});

test("book account IDL round-trips four empty/populated heads and full-width IDs", async () => {
  const { Program, BN } = require("@anchor-lang/core");
  const { Connection } = require("@solana/web3.js");
  const idl = JSON.parse(
    readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
  );
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const market = new PublicKey(new Uint8Array(32).fill(3));
  const fields = ["yesBestBid", "yesBestAsk", "noBestBid", "noBestAsk"];
  for (const populated of [false, true]) {
    const book = {
      market,
      nextOrderId: new BN(populated ? "18446744073709551615" : "1"),
      bump: 255,
    };
    for (const [i, field] of fields.entries())
      book[field] = populated ? new BN(String((i + 1) * 10000)) : null;
    const data = await program.coder.accounts.encode(
      "predictionOrderBook",
      book,
    );
    if (populated) assert.equal(data.length, 85);
    else assert.equal(data.length, 53); // Empty Options serialize only their tags.
    const decoded = program.coder.accounts.decode(
      "predictionOrderBook",
      Buffer.concat([data, Buffer.alloc(85 - data.length)]),
    );
    assert.equal(decoded.market.toBase58(), market.toBase58());
    assert.equal(decoded.nextOrderId.toString(), book.nextOrderId.toString());
    assert.equal(decoded.bump, 255);
    for (const field of fields)
      assert.equal(
        decoded[field]?.toString() ?? null,
        book[field]?.toString() ?? null,
      );
  }
});
