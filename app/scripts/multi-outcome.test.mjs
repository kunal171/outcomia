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
    visibility.visibleMarket(
      "4AhXYjfYy5kVBTyWbmrxFJ7KmydghcaktprU74aVv5kC",
      "Anything",
    ),
    false,
  );
  assert.equal(
    visibility.visibleMarket("other", "SMOKE ONLY - shared wallet settlement"),
    false,
  );
  assert.equal(
    visibility.visibleMarket("other", "Will candidate A win?"),
    true,
  );
  assert.equal(
    visibility.visibleMarket("other", "Will wildfire smoke clear tomorrow?"),
    true,
  ); // Names used by this release's deployment smoke test, for every market kind.
  for (const name of [
    "Smoke test - multi-outcome lifecycle",
    "Smoke test - binary corrections",
    "Smoke test",
    "smoke-test spot",
  ])
    assert.equal(visibility.visibleMarket("other", name), false, name);
  // Unnamed markets (metadata unavailable) stay visible unless listed.
  assert.equal(visibility.visibleMarket("other"), true);
  // The release smoke market stays hidden even without its metadata name.
  assert.equal(
    visibility.visibleMarket("Ey5p8bBin49gfiaCuE7qHPdy8LdomzZX2tQEASbdo8ar"),
    false,
  );
});

test("resolution follows stored phase, earliest time, review maturity and exclusive fallback deadline", () => {
  const { resolutionAvailability: available } = loadTypeScript(
    new URL("../lib/multi-outcome-lifecycle.ts", import.meta.url),
  );
  const state = {
    terms: {
      ...terms,
      closeTs: new BN(100),
      earliestResolutionTs: new BN(110),
      resolutionDelaySeconds: new BN(20),
      fallback: {
        resolver: maker,
        availableTs: new BN(130),
        deadlineTs: new BN(180),
      },
    },
    status: { open: {} },
    resolutionPhase: { primary: {} },
    proposal: null,
    finalOutcome: null,
  };
  assert.equal(available(state, owner, true, 105).canPropose, false);
  assert.equal(available(state, owner, true, 110).canPropose, true);
  assert.equal(available(state, maker, true, 130).canPropose, false);
  assert.equal(available(state, owner, true, 130).canPropose, false);
  assert.equal(available(state, maker, false, 130).canActivateFallback, true);
  const activated = {
    ...state,
    status: { frozen: {} },
    resolutionPhase: { fallback: {} },
  };
  assert.equal(available(activated, maker, true, 130).canPropose, true);
  assert.equal(available(activated, maker, false, 130).canPropose, false);
  assert.equal(
    available(activated, maker, true, 130).canActivateFallback,
    false,
  );
  assert.equal(available(activated, maker, true, 180).canPropose, false);
  assert.equal(available(activated, maker, true, 180).canTimeout, true);
  const primaryProposal = {
    ...state,
    status: { proposed: {} },
    proposal: {
      proposedAt: new BN(120),
      outcome: { winner: [[0]] },
      evidenceUri: "ar://proof",
      evidenceHash: Array(32).fill(1),
    },
  };
  assert.equal(available(primaryProposal, maker, true, 131).canPropose, false);
  assert.equal(available(primaryProposal, owner, true, 131).canPropose, false);
  assert.equal(available(primaryProposal, maker, false, 140).canFinalize, true);
  assert.equal(
    available(primaryProposal, maker, false, 140).canActivateFallback,
    false,
  );
  assert.equal(available(primaryProposal, maker, false, 180).canTimeout, false);
});

test("primary corrections stop at earliest resolution plus two review delays", () => {
  const { resolutionAvailability: available } = loadTypeScript(
    new URL("../lib/multi-outcome-lifecycle.ts", import.meta.url),
  );
  // No fallback: earliest 110 + 2 * 20 gives a correction deadline of 150.
  const proposed = {
    terms: {
      ...terms,
      closeTs: new BN(100),
      earliestResolutionTs: new BN(110),
      resolutionDelaySeconds: new BN(20),
      fallback: null,
    },
    status: { proposed: {} },
    resolutionPhase: { primary: {} },
    proposal: {
      proposedAt: new BN(140),
      outcome: { winner: [[0]] },
      evidenceUri: "ar://proof",
      evidenceHash: Array(32).fill(1),
    },
    finalOutcome: null,
  };
  assert.equal(
    available(proposed, owner, true, 149).correctionDeadline.toNumber(),
    150,
  );
  assert.equal(available(proposed, owner, true, 149).canPropose, true);
  // Still before maturity (160), but the correction window has closed.
  assert.equal(available(proposed, owner, true, 150).canPropose, false);
  assert.equal(available(proposed, owner, false, 160).canFinalize, true);
});

test("mutable owner/market account scans bypass discovery cache", async () => {
  const { createRpcFetch } = loadTypeScript(
    new URL("../lib/rpc-transport.ts", import.meta.url),
  );
  let scans = 0;
  const transport = createRpcFetch(
    ["https://rpc.fixture.invalid"],
    async (_url, init) => {
      const request = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result:
            request.method === "getGenesisHash"
              ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
              : ++scans,
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  const read = async (filters) =>
    (
      await transport("https://rpc.fixture.invalid", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getProgramAccounts",
          params: [market.toBase58(), { filters }],
        }),
      })
    ).json();
  const filtered = [{ memcmp: { offset: 40, bytes: owner.toBase58() } }];
  assert.equal((await read(filtered)).result, 1);
  assert.equal((await read(filtered)).result, 2);
  const discovery = [{ memcmp: { offset: 0, bytes: "aDiscriminator" } }];
  assert.equal((await read(discovery)).result, 3);
  assert.equal((await read(discovery)).result, 3);
});

test("wallet activity filters owners and verifies canonical positions and markets", async () => {
  const { loadMultiWallet } = loadTypeScript(
    new URL("../lib/multi-outcome-wallet.ts", import.meta.url),
  );
  const id = Buffer.alloc(32, 7),
    key = m.multiMarketPda(id);
  let position = {
    owner,
    market: key,
    free: Array.from({ length: 8 }, () => new BN(3)),
    locked: Array.from({ length: 8 }, () => new BN(0)),
  };
  const reader = {
    account: {
      multiOutcomePosition: {
        all: async (filters) => {
          assert.equal(filters[0].memcmp.offset, 40);
          return [
            { publicKey: m.multiPositionPda(key, owner), account: position },
          ];
        },
      },
      multiOutcomeMarket: {
        fetchNullable: async () => ({
          marketId: [...id],
          terms,
          collateralMint: mint,
        }),
      },
      marketMetadata: {
        fetchNullable: async () => ({
          market: key,
          displayName: "Three-way",
          quoteSymbol: "USDC",
        }),
      },
    },
  };
  const result = await loadMultiWallet(reader, owner, "positions");
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Three-way");
  assert.equal(result[0].decimals, 6);
  position = { ...position, owner: maker };
  await assert.rejects(
    loadMultiWallet(reader, owner, "positions"),
    /position identity/,
  );
});

test("IDL sync preserves compiled account and field order when signatures change", async () => {
  const { mergeIdl } = await import("./support/idl-sync.mjs");
  const before = {
    instructions: [
      {
        name: "trade",
        accounts: [{ name: "maker" }, { name: "taker" }],
        docs: ["Existing docs"],
      },
    ],
    types: [
      {
        name: "Balance",
        type: {
          kind: "struct",
          fields: [
            { name: "free", type: "u64" },
            { name: "locked", type: "u64" },
          ],
        },
      },
    ],
  };
  const after = {
    instructions: [
      { name: "trade", accounts: [{ name: "taker" }, { name: "maker" }] },
    ],
    types: [
      {
        name: "Balance",
        type: {
          kind: "struct",
          fields: [
            { name: "locked", type: "u64" },
            { name: "free", type: "u64" },
          ],
        },
      },
    ],
  };
  const merged = mergeIdl(before, after);
  assert.deepEqual(
    merged.instructions[0].accounts,
    after.instructions[0].accounts,
  );
  assert.deepEqual(merged.types[0].type.fields, after.types[0].type.fields);
  assert.deepEqual(merged.instructions[0].docs, ["Existing docs"]);
});

/** Builds a linked, validated book from [outcome, side, price, quantity, ownerKey]
 * specs in time order; each outcome/side queue is sorted by price-time priority. */
function linkedBook(specs, count = 3) {
  const rows = specs.map(([outcome, side, price, quantity, who], i) => ({
    publicKey: m.multiOrderPda(bookKey, new BN(i + 1)),
    account: {
      owner: who,
      market,
      book: bookKey,
      orderId: new BN(i + 1),
      outcome: [outcome],
      side: { [side]: {} },
      price: new BN(price),
      quantity: new BN(quantity),
      remainingQuantity: new BN(quantity),
      lockedAmount: new BN(side === "bid" ? price * quantity : quantity),
      status: { open: {} },
      previous: null,
      next: null,
    },
  }));
  const heads = Array(16).fill(null);
  for (let slot = 0; slot < 16; slot++) {
    const queue = rows
      .filter((r) => m.slot(r.account.outcome[0], m.sideOf(r.account)) === slot)
      .sort((a, b) => m.priority(a.account, b.account));
    queue.forEach((r, i) => {
      r.account.previous = queue[i - 1]?.publicKey ?? null;
      r.account.next = queue[i + 1]?.publicKey ?? null;
    });
    if (queue[0])
      heads[slot] = { order: queue[0].publicKey, ...queue[0].account };
  }
  return {
    rows,
    book: {
      market,
      authority: owner,
      heads,
      nextOrderId: new BN(rows.length + 1),
      openOrderCount: new BN(rows.length),
      accruedCollateralFees: new BN(0),
    },
    market: {
      terms: {
        ...terms,
        outcomeLabels: Array.from({ length: count }, (_, i) => `O${i}`),
        quantityLot: new BN(3),
      },
      collateralMint: mint,
    },
  };
}
const plan = (f, outcome, side, price, quantity, complement = true) =>
  m.buildMultiTrade(
    p,
    market,
    f.market,
    f.book,
    f.rows,
    owner,
    outcome,
    side,
    new BN(price),
    new BN(quantity),
    100,
    complement,
  );
const names = (r) =>
  r.transaction.instructions.map(
    (ix) => p.coder.instruction.decode(ix.data).name,
  );

test("a cheaper full set fills before direct asks, then direct liquidity", async () => {
  const other = key(6);
  // Outcome 1 and 2 bids sum to 0.55, so outcome 0 buys at 0.45 via a full set,
  // cheaper than the direct 0.48 ask.
  const f = linkedBook([
    [1, "bid", 300000, 3, maker],
    [2, "bid", 250000, 6, other],
    [0, "ask", 480000, 3, maker],
  ]);
  const r = await plan(f, 0, "bid", 500000, 6);
  assert.deepEqual(names(r), [
    "matchMultiOutcomeComplement",
    "matchMultiOutcomeOrder",
  ]);
  // 3 x 0.45 + 3 x 0.48 = 2.79; fees 1% of each leg's notional, rounded up.
  assert.equal(r.cost.toString(), "2790000");
  assert.equal(r.fees.toString(), String(13500 + 14400));
  assert.equal(r.remaining.toString(), "0");
  // Remaining accounts: [order, next, cash, position] for outcome 1 then 2.
  const ix = r.transaction.instructions[0];
  const fixed = idl.instructions.find(
    (i) => i.name === "match_multi_outcome_complement",
  ).accounts.length;
  const tail = ix.keys.slice(fixed).map((k) => k.pubkey);
  assert.equal(tail.length, 8);
  assert.ok(tail[0].equals(f.rows[0].publicKey));
  assert.ok(
    tail[1].equals(new PublicKey(idl.address)),
    "completed head without successor",
  );
  assert.ok(tail[4].equals(f.rows[1].publicKey));
  assert.ok(
    tail[5].equals(new PublicKey(idl.address)),
    "partial head keeps no successor",
  );
  assert.ok(tail[7].equals(m.multiPositionPda(market, other)));
  assert.ok(m.transactionBytes(r.transaction, owner) <= 1232);
});

test("sells merge against every other outcome's best ask", async () => {
  const f = linkedBook([
    [1, "ask", 400000, 3, maker],
    [2, "ask", 350000, 3, key(6)],
  ]);
  // Selling outcome 0 at 0.20 or better receives 1 - 0.40 - 0.35 = 0.25.
  const r = await plan(f, 0, "ask", 200000, 3);
  assert.deepEqual(names(r), ["matchMultiOutcomeComplement"]);
  assert.equal(r.cost.toString(), "750000");
});

test("remainders rest only when no full set or direct order still crosses", async () => {
  const f = linkedBook([
    [1, "bid", 300000, 3, maker],
    [2, "bid", 250000, 3, key(6)],
  ]);
  // 0.44 + 0.55 < 1: no full set, so the bid rests.
  const rest = await plan(f, 0, "bid", 440000, 3);
  assert.deepEqual(names(rest), ["placeMultiOutcomeOrder"]);
  // Four crossing heads per outcome exceed the three-instruction cap: no unsafe rest.
  const deep = linkedBook([
    ...[0, 1, 2, 3].map((i) => [1, "bid", 300000 - i * 10000, 3, maker]),
    ...[0, 1, 2, 3].map((i) => [2, "bid", 250000, 3, key(6)]),
  ]);
  const capped = await plan(deep, 0, "bid", 600000, 15);
  assert.ok(names(capped).every((n) => n === "matchMultiOutcomeComplement"));
  assert.ok(capped.remaining.gtn(0));
  assert.ok(!names(capped).includes("placeMultiOutcomeOrder"));
});

test("own orders heading another outcome block a full set", async () => {
  const f = linkedBook([
    [1, "bid", 300000, 3, owner],
    [2, "bid", 250000, 3, maker],
  ]);
  await assert.rejects(plan(f, 0, "bid", 500000, 3), /heads another outcome/);
});

test("with complementary matching disabled only direct liquidity is used", async () => {
  const f = linkedBook([
    [1, "bid", 300000, 3, maker],
    [2, "bid", 250000, 3, key(6)],
  ]);
  const r = await plan(f, 0, "bid", 500000, 3, false);
  assert.deepEqual(names(r), ["placeMultiOutcomeOrder"]);
});

test("oversized full sets fall back to direct liquidity, else explain the limit", async () => {
  // Eight outcomes with distinct makers need too many accounts for one packet.
  const specs = [];
  for (let j = 1; j < 8; j++) specs.push([j, "bid", 50000, 3, key(20 + j)]);
  const withDirect = linkedBook([...specs, [0, "ask", 700000, 3, maker]], 8);
  const r = await plan(withDirect, 0, "bid", 800000, 3);
  assert.deepEqual(names(r), ["matchMultiOutcomeOrder"]);
  const only = linkedBook(specs, 8);
  await assert.rejects(plan(only, 0, "bid", 800000, 3), /full-set price/);
});

test("full-set quotes price each outcome through the others' best orders", () => {
  const f = linkedBook([
    [1, "bid", 300000, 6, maker],
    [2, "bid", 250000, 3, key(6)],
    [1, "ask", 400000, 3, maker],
  ]);
  const buy = m.fullSetQuote(f.market, f.book, 0, "bid", f.rows);
  assert.equal(buy.price.toString(), "450000");
  assert.equal(buy.quantity.toString(), "3");
  // Outcome 2 has no ask, so no full-set sell quote exists.
  assert.equal(m.fullSetQuote(f.market, f.book, 0, "ask", f.rows), null);
});
