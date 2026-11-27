// Multi-outcome Canton markets: creation terms, complete sets, factory-admin
// resolution, operator finalization and exact claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPlan,
  multiResultArg,
  standardTerms,
} from "../lib/canton/commands.ts";
import { decodeContracts, multiResult } from "../lib/canton/model.ts";
import {
  lotTotals,
  multiClaim,
  outcomeQuotes,
  parseOutcomes,
} from "../lib/canton/multi.ts";
import {
  d as base,
  instrument,
  terms as binaryTerms,
  c,
  policy,
  balance,
  admission,
  roots,
} from "./fixtures/canton.mjs";

const d = { ...base, factoryPackageId: "f".repeat(64) };
const ref = {
  operator: d.operator,
  namespace: d.namespace,
  factoryId: "public",
};
const key = {
  operator: d.operator,
  protocolName: d.namespace,
  marketId: "3",
  scope: ref,
};
const terms = {
  question: "Which team wins the final?",
  collateral: instrument,
  outcomes: ["Red", "Blue", "Green", "Gold"],
  outcomeCriteria: ["Red wins", "Blue wins", "Green wins", "Gold wins"],
  invalidCriteria: binaryTerms.rules.invalidCriteria,
  evidenceRequirements: binaryTerms.rules.evidenceRequirements,
  documentUri: binaryTerms.rules.documentUri,
  documentSha256: binaryTerms.rules.documentSha256,
  closeAt: "2099-01-01T00:00:00Z",
  earliestResolutionAt: null,
  resolutionDelaySeconds: "3600",
  priceTick: "0.01",
  quantityLot: "1",
};
const factory = c("OutcomiaMarketFactory", "factory-cid", {
  operator: d.operator,
  vault: d.vault,
  protocolName: d.namespace,
  ref,
  admins: ["alice", "bob"],
  policy: { tag: "AdminsOnly", value: ["alice"] },
  assets: [{ instrument, admission: "admission" }],
  nextNumber: "4",
  nextPolicyNumber: "1",
});
const market = c("MultiMarket", "mmarket", {
  key,
  creator: "alice",
  terms,
  createdAt: "2026-01-01T00:00:00Z",
  openedAt: "2026-01-01T00:00:00Z",
  status: "Open",
  closeReason: null,
  access: null,
});
const reserve = c("MultiReserve", "mreserve", {
  key,
  vault: d.vault,
  creator: "alice",
  terms,
  createdAt: "2026-01-01T00:00:00Z",
  factory: "factory",
  assetDecimals: "6",
  completeSets: "2",
  cash: "cash",
});
const lot = c("MultiLot", "mlot", {
  key,
  vault: d.vault,
  owner: "alice",
  counts: ["2", "2", "0", "2"],
});
const snapshot = (...extra) => ({
  deployment: d,
  contracts: [policy, factory, market, reserve, admission, ...roots, ...extra],
  quotes: [],
});
const plan = (party, action, target, values, contracts = snapshot()) =>
  buildPlan(party, contracts, [balance, lot], { action, target, values });
const exercise = (p) => p.command.ExerciseCommand;
const evidence = {
  summary: "Official result",
  documentUri: "ar://result",
  documentSha256: "a".repeat(64),
};

test("multi-outcome creation terms", () => {
  const standard = {
    question: terms.question,
    outcomes: terms.outcomes,
    outcomeCriteria: terms.outcomeCriteria,
    invalidCriteria: terms.invalidCriteria,
    evidenceRequirements: terms.evidenceRequirements,
    rulesUri: terms.documentUri,
    rulesHash: terms.documentSha256,
    collateral: instrument,
    closeAt: terms.closeAt,
    earliestResolutionAt: null,
    resolutionDelaySeconds: "3600",
    priceTick: "0.01",
    quantityLot: "1",
  };
  assert.equal(standardTerms(standard), standard);
  assert.throws(
    () => standardTerms({ ...standard, outcomes: ["Red", "Red", "B", "C"] }),
    /unique outcome labels/,
  );
  assert.throws(
    () =>
      standardTerms({
        ...standard,
        outcomes: "ABCDEFGHI".split(""),
        outcomeCriteria: "ABCDEFGHI".split(""),
      }),
    /2 to 8/,
  );
  assert.throws(
    () => standardTerms({ ...standard, outcomeCriteria: ["only one"] }),
    /its own criterion/,
  );
  assert.deepEqual(parseOutcomes("Red: Red wins\n\nBlue\n Gold : Gold wins "), {
    outcomes: ["Red", "Blue", "Gold"],
    outcomeCriteria: ["Red wins", "Blue", "Gold wins"],
  });
  assert.throws(() => parseOutcomes("Only"), /2 to 8/);
});

test("complete sets mint and return through the reserve", () => {
  const split = exercise(
    plan("alice", "multiSplit", "mreserve", { quantity: "2" }),
  );
  assert.equal(split.choice, "MultiReserve_Split");
  assert.deepEqual(split.choiceArgument, {
    owner: "alice",
    balance: "balance",
    quantity: "2",
    market: "mmarket",
    eligibility: null,
  });
  const merge = exercise(
    plan("alice", "multiMerge", "mreserve", { quantity: "1" }),
  );
  assert.equal(merge.choice, "MultiReserve_Merge");
  assert.deepEqual(merge.choiceArgument.positions, ["mlot"]);
  assert.throws(
    () => plan("alice", "multiSplit", "mreserve", { quantity: "0" }),
    /contract lot/,
  );
  const closed = {
    ...market,
    data: { ...market.data, status: "Closed", closeReason: "Stop" },
  };
  assert.throws(
    () =>
      buildPlan(
        "alice",
        {
          ...snapshot(),
          contracts: [policy, factory, closed, reserve, admission, ...roots],
        },
        [balance, lot],
        { action: "multiSplit", target: "mreserve", values: { quantity: "1" } },
      ),
    /not open/,
  );
});

test("factory admins propose and correct; the operator finalizes and binds", () => {
  assert.deepEqual(multiResultArg("2", 4), { tag: "Winner", value: "2" });
  assert.deepEqual(multiResultArg("invalid", 4), {
    tag: "InvalidResult",
    value: {},
  });
  assert.throws(() => multiResultArg("4", 4), /outcomes or invalid/);
  assert.throws(
    () => plan("carol", "multiPropose", "mmarket", { result: "1", evidence }),
    /factory required/,
  );
  // The market closes in 2099, so resolution is not open yet.
  assert.throws(
    () => plan("bob", "multiPropose", "mmarket", { result: "1", evidence }),
    /not available yet/,
  );
  const close = exercise(
    plan("bob", "multiClose", "mmarket", { reason: "Event postponed" }),
  );
  assert.equal(close.choice, "Multi_Close");
  assert.equal(close.choiceArgument.roles, "factory-cid");

  const proposal = c("MultiProposal", "mproposal", {
    key,
    creator: "alice",
    terms,
    marketCreatedAt: "2026-01-01T00:00:00Z",
    openedAt: "2026-01-01T00:00:00Z",
    proposedBy: "bob",
    result: { tag: "Winner", value: "1" },
    evidence,
    proposedAt: "2099-01-02T00:00:00Z",
    finalizableAt: "2999-01-01T00:00:00Z",
    revision: "0",
  });
  const withProposal = snapshot(proposal);
  const correct = exercise(
    plan(
      "alice",
      "multiCorrect",
      "mproposal",
      { result: "invalid", evidence },
      withProposal,
    ),
  );
  assert.equal(correct.choice, "MultiProposal_Correct");
  assert.deepEqual(correct.choiceArgument.replacementResult, {
    tag: "InvalidResult",
    value: {},
  });
  assert.throws(
    () => plan(d.operator, "multiFinalize", "mproposal", {}, withProposal),
    /Review delay/,
  );
  const final = c("MultiFinal", "mfinal", {
    proposal: proposal.data,
    finalizedAt: "2999-01-02T00:00:00Z",
  });
  const bind = exercise(
    plan(d.operator, "multiBind", "mreserve", {}, snapshot(final)),
  );
  assert.equal(bind.choice, "MultiReserve_BindResolution");
  assert.deepEqual(bind.choiceArgument, { resolution: "mfinal" });
  assert.throws(
    () => plan("alice", "multiBind", "mreserve", {}, snapshot(final)),
    /Operator wallet/,
  );
});

test("claims pay the winner or an equal invalid share", () => {
  const totals = lotTotals([lot], 4);
  assert.deepEqual(totals, [BigInt(2), BigInt(2), BigInt(0), BigInt(2)]);
  assert.equal(multiClaim(totals, 0), "2");
  assert.equal(multiClaim(totals, 2), "0");
  assert.equal(multiClaim(totals, null), "1.5");
  const settled = c("MultiSettledReserve", "msettled", {
    ...reserve.data,
    resolution: "mfinal",
    result: { tag: "InvalidResult", value: {} },
    outstanding: ["2", "2", "2", "2"],
    remainingCollateral: "2",
  });
  const redeem = exercise(
    plan("alice", "multiRedeem", "msettled", {}, snapshot(settled)),
  );
  assert.equal(redeem.choice, "MultiSettled_Redeem");
  assert.deepEqual(redeem.choiceArgument, {
    owner: "alice",
    balance: "balance",
    positions: ["mlot"],
  });
  assert.deepEqual(multiResult({ tag: "Winner", value: "3" }), { winner: 3 });
});

test("ledger snapshots decode multi-outcome records", () => {
  const row = (name, data) => ({
    contractEntry: {
      JsActiveContract: {
        createdEvent: {
          contractId: `${name}-id`,
          templateId: `${d.packageId}:Outcomia.MultiOutcome:${name}`,
          createArgument: data,
        },
      },
    },
  });
  const decoded = decodeContracts(
    [row("MultiMarket", market.data), row("MultiLot", lot.data)],
    d,
  );
  assert.deepEqual(
    decoded.map((x) => x.kind),
    ["MultiMarket", "MultiLot"],
  );
  assert.throws(
    () => decodeContracts([row("MultiLot", { ...lot.data, counts: ["1"] })], d),
    /multi-outcome position/,
  );
});

test("per-outcome orders place, cancel and match on the multi book", () => {
  const order = (id, owner, side, price, outcome = "2") =>
    c("MultiOrder", id, {
      key,
      vault: d.vault,
      owner,
      instrument,
      factory: "factory",
      outcomeCount: "4",
      outcome,
      side,
      price,
      quantity: "1",
      orderId: id === "bid" ? "2" : "1",
    });
  const ask = order("ask", "bob", "Sell", "0.30"),
    bid = order("bid", "alice", "Buy", "0.40");
  const book = c("MultiBook", "mbook", {
    key,
    vault: d.vault,
    creator: "alice",
    terms,
    factory: "factory",
    assetDecimals: "6",
    nextOrderId: "3",
    orders: [
      { orderId: "1", order: "ask", outcome: "2", side: "Sell", price: "0.30" },
      { orderId: "2", order: "bid", outcome: "2", side: "Buy", price: "0.40" },
    ],
    fees: { amount: "0.003", cash: "fees" },
    clubShareBps: "0",
    clubFees: "0.001",
  });
  const contracts = snapshot(book);
  const run = (party, action, target, values, o) =>
    buildPlan(party, contracts, o, { action, target, values });
  const bobBalance = {
    ...balance,
    id: "bob-balance",
    data: { ...balance.data, owner: "bob" },
  };

  const placed = exercise(
    run(
      "alice",
      "multiBuy",
      "mbook",
      { outcome: "2", price: "0.40", quantity: "1" },
      [balance],
    ),
  );
  assert.equal(placed.choice, "MultiBook_PlaceBuy");
  assert.equal(placed.choiceArgument.outcome, "2");
  assert.equal(placed.choiceArgument.balance, "balance");
  assert.equal(placed.choiceArgument.expectedFeeRevision, "3");
  assert.throws(
    () =>
      run(
        "alice",
        "multiBuy",
        "mbook",
        { outcome: "4", price: "0.40", quantity: "1" },
        [balance],
      ),
    /outcomes/,
  );
  const sold = exercise(
    run(
      "alice",
      "multiSell",
      "mbook",
      { outcome: "1", price: "0.50", quantity: "2" },
      [balance, lot],
    ),
  );
  assert.equal(sold.choice, "MultiBook_PlaceSell");
  assert.deepEqual(sold.choiceArgument.positions, ["mlot"]);
  // Alice holds no contracts of outcome 2.
  assert.throws(
    () =>
      run(
        "alice",
        "multiSell",
        "mbook",
        { outcome: "2", price: "0.50", quantity: "1" },
        [balance, lot],
      ),
    /Insufficient/,
  );

  const cancel = run("alice", "multiCancel", "bid", {}, [balance, bid]);
  assert.equal(exercise(cancel).choice, "MultiBook_Cancel");
  assert.equal(exercise(cancel).contractId, "mbook");
  assert.throws(
    () => run("alice", "multiCancel", "ask", {}, [balance, ask]),
    /another wallet/,
  );

  const matched = exercise(
    run(d.operator, "multiMatch", "mbook", { outcome: "2" }, [
      balance,
      bobBalance,
      ask,
      bid,
    ]),
  );
  assert.equal(matched.choice, "MultiBook_MatchBest");
  assert.deepEqual(
    [matched.choiceArgument.buyerBalance, matched.choiceArgument.sellerBalance],
    ["balance", "bob-balance"],
  );
  assert.throws(
    () =>
      run(d.operator, "multiMatch", "mbook", { outcome: "1" }, [
        balance,
        bobBalance,
        ask,
        bid,
      ]),
    /No crossed/,
  );
  assert.throws(
    () =>
      run(d.operator, "multiWithdrawFees", "mbook", { amount: "0.003" }, []),
    /owed to a club/,
  );
  assert.equal(
    exercise(
      run(d.operator, "multiWithdrawFees", "mbook", { amount: "0.002" }, []),
    ).choice,
    "MultiBook_WithdrawFees",
  );
});

test("full sets match one head per outcome and quotes show implied prices", () => {
  const owners = ["alice", "bob", "carol", "dave"];
  const bids = owners.map((owner, i) =>
    c("MultiOrder", `b${i}`, {
      key,
      vault: d.vault,
      owner,
      instrument,
      factory: "factory",
      outcomeCount: "4",
      outcome: String(i),
      side: "Buy",
      price: ["0.30", "0.20", "0.20", "0.40"][i],
      quantity: "1",
      orderId: String(i + 1),
    }),
  );
  const book = c("MultiBook", "fbook", {
    key,
    vault: d.vault,
    creator: "alice",
    terms,
    factory: "factory",
    assetDecimals: "6",
    nextOrderId: "5",
    orders: bids.map((b) => ({
      orderId: b.data.orderId,
      order: b.id,
      outcome: b.data.outcome,
      side: "Buy",
      price: b.data.price,
    })),
    fees: { amount: "0", cash: null },
    clubShareBps: "0",
    clubFees: "0",
  });
  const accounts = owners.map((owner) => ({
    ...balance,
    id: `${owner}-balance`,
    data: { ...balance.data, owner },
  }));
  const contracts = snapshot(book);
  const run = (side, o) =>
    buildPlan(d.operator, contracts, o, {
      action: "multiMatchFullSet",
      target: "fbook",
      values: { side },
    });
  const matched = exercise(run("Buy", [...accounts, ...bids]));
  assert.equal(matched.choice, "MultiBook_MatchFullSet");
  assert.equal(matched.choiceArgument.reserve, "mreserve");
  assert.deepEqual(
    matched.choiceArgument.balances,
    owners.map((o) => `${o}-balance`),
  );
  assert.deepEqual(matched.choiceArgument.eligibility, [
    null,
    null,
    null,
    null,
  ]);
  // No asks: nothing to merge. Without the Gold bid, nothing to mint.
  assert.throws(() => run("Sell", [...accounts, ...bids]), /Every outcome/);
  assert.throws(
    () =>
      buildPlan(
        d.operator,
        snapshot({
          ...book,
          data: { ...book.data, orders: book.data.orders.slice(0, 3) },
        }),
        [...accounts, ...bids],
        {
          action: "multiMatchFullSet",
          target: "fbook",
          values: { side: "Buy" },
        },
      ),
    /Every outcome/,
  );
  assert.throws(
    () =>
      buildPlan("alice", contracts, [...accounts, ...bids], {
        action: "multiMatchFullSet",
        target: "fbook",
        values: { side: "Buy" },
      }),
    /Operator wallet/,
  );

  const q = outcomeQuotes(
    4,
    [
      { side: "Buy", outcome: "0", price: "0.30" },
      { side: "Buy", outcome: "1", price: "0.20" },
      { side: "Buy", outcome: "2", price: "0.20" },
      { side: "Sell", outcome: "3", price: "0.45" },
    ],
    [
      { kind: "trade", outcome: "3", price: "0.4100000000" },
      { kind: "trade", outcome: "3", price: "0.3900000000" },
    ],
  );
  // Gold costs 1 - 0.70 = 0.30 through a set; its last trade is the newest fill.
  assert.deepEqual(q[3], {
    bid: undefined,
    ask: "0.45",
    impliedAsk: "0.3",
    impliedBid: undefined,
    last: "0.41",
  });
  assert.equal(q[0].impliedAsk, undefined);
});
