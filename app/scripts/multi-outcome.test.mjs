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
  assert.equal(
    visibility.visiblePredictionMarket(
      "other",
      "Will wildfire smoke clear tomorrow?",
    ),
    true,
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
