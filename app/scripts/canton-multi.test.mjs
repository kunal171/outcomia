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
import { lotTotals, multiClaim, parseOutcomes } from "../lib/canton/multi.ts";
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
