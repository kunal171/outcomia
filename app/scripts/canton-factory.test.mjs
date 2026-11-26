// Market-factory commands: creation through the standard interface, invite
// lists, eligibility proofs and factory-scoped management.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, mayCreate } from "../lib/canton/commands.ts";
import { marketKey } from "../lib/canton/model.ts";
import {
  d as base,
  instrument,
  terms,
  c,
  policy,
  market as protocolMarket,
  balance,
  position,
  admission,
  roots,
} from "./fixtures/canton.mjs";

const d = { ...base, factoryPackageId: "f".repeat(64) };
const ref = {
  operator: d.operator,
  namespace: d.namespace,
  factoryId: "public",
};
const listRef = {
  operator: d.operator,
  namespace: d.namespace,
  policyId: "invite/public/1",
};
const scopedKey = {
  operator: d.operator,
  protocolName: d.namespace,
  marketId: "1",
  scope: ref,
};
const factory = c("OutcomiaMarketFactory", "factory-cid", {
  operator: d.operator,
  vault: d.vault,
  protocolName: d.namespace,
  ref,
  admins: ["alice", "bob"],
  policy: { tag: "AdminsOnly", value: ["alice"] },
  assets: [{ instrument, admission: "admission" }],
  nextNumber: "2",
  nextPolicyNumber: "2",
});
const restricted = c("BinaryMarket", "fmarket", {
  operator: d.operator,
  protocolName: d.namespace,
  marketId: "1",
  creator: "alice",
  terms,
  status: "Open",
  createdAt: "2026-01-01T00:00:00Z",
  openedAt: "2026-01-01T00:00:00Z",
  factory: ref,
  access: listRef,
});
const fbook = c("OrderBook", "fbook", {
  key: scopedKey,
  vault: d.vault,
  creator: "alice",
  terms,
  factory: "factory",
  assetDecimals: "6",
  orders: [],
  fees: { amount: "0", cash: null },
});
const freserve = c("MarketReserve", "freserve", {
  key: scopedKey,
  vault: d.vault,
  creator: "alice",
  terms,
  factory: "factory",
  assetDecimals: "6",
  completeSets: "0",
  cash: null,
});
const invites = c("InviteListPolicy", "invites", {
  operator: d.operator,
  manager: "alice",
  ref: listRef,
  parties: ["carol"],
});
const snapshot = {
  deployment: d,
  contracts: [
    policy,
    protocolMarket,
    factory,
    restricted,
    fbook,
    freserve,
    admission,
    ...roots,
  ],
  quotes: [],
};
const owned = [balance, position, invites];
const standard = {
  question: terms.question,
  outcomes: ["YES", "NO"],
  outcomeCriteria: [terms.rules.yesCriteria, terms.rules.noCriteria],
  invalidCriteria: terms.rules.invalidCriteria,
  evidenceRequirements: terms.rules.evidenceRequirements,
  rulesUri: terms.rules.documentUri,
  rulesHash: terms.rules.documentSha256,
  collateral: instrument,
  closeAt: terms.closeAt,
  earliestResolutionAt: null,
  resolutionDelaySeconds: "3600",
  priceTick: "0.01",
  quantityLot: "1",
};
const plan = (party, action, target, values, o = owned) =>
  buildPlan(party, snapshot, o, { action, target, values });
const args = (p) => p.command.ExerciseCommand.choiceArgument;

test("factory and protocol market #1 are different markets", () => {
  assert.notEqual(marketKey(restricted.data), marketKey(protocolMarket.data));
  assert.equal(marketKey(restricted.data), marketKey(fbook.data));
});

test("creation goes through the standard interface under the creation policy", () => {
  const p = plan("alice", "factoryCreate", "factory-cid", { terms: standard });
  assert.equal(
    p.command.ExerciseCommand.templateId,
    `${"f".repeat(64)}:Canton.MarketFactory:MarketFactory`,
  );
  assert.equal(p.command.ExerciseCommand.contractId, "factory-cid");
  assert.equal(p.command.ExerciseCommand.choice, "MarketFactory_Create");
  assert.deepEqual(args(p).access, { tag: "Public", value: {} });
  assert.equal(args(p).creator, "alice");
  assert.throws(
    () => plan("bob", "factoryCreate", "factory-cid", { terms: standard }),
    /creation policy/,
  );
  assert.throws(
    () =>
      plan("alice", "factoryCreate", "factory-cid", {
        terms: { ...standard, collateral: { admin: "x", id: "Y" } },
      }),
    /collateral/,
  );
  assert.throws(
    () =>
      plan("alice", "factoryCreate", "factory-cid", {
        terms: { ...standard, outcomes: ["NO", "YES"] },
      }),
    /YES before NO/,
  );
  const invite = plan("alice", "factoryCreate", "factory-cid", {
    terms: standard,
    access: "invite",
    policy: "invites",
  });
  assert.deepEqual(args(invite).access, { tag: "Restricted", value: listRef });
});

test("creation policies match the standard", () => {
  assert.equal(mayCreate({ tag: "AnyParty", value: {} }, "anyone"), true);
  assert.equal(mayCreate({ tag: "Allowlist", value: ["x"] }, "x"), true);
  assert.equal(mayCreate({ tag: "AdminsOnly", value: ["x"] }, "y"), false);
  assert.equal(mayCreate({ tag: "Unknown" }, "x"), false);
});

test("restricted markets attach the market's own policy, public ones none", () => {
  const carolBalance = {
    ...balance,
    id: "carol-balance",
    data: { ...balance.data, owner: "carol" },
  };
  const p = plan("carol", "split", "freserve", { quantity: "1" }, [
    carolBalance,
    invites,
  ]);
  assert.deepEqual(args(p).eligibility, { policy: "invites", evidence: [] });
  assert(p.dependencies.includes("invites"));
  assert.throws(
    () =>
      plan("dave", "split", "freserve", { quantity: "1" }, [
        { ...carolBalance, data: { ...carolBalance.data, owner: "dave" } },
        invites,
      ]),
    /not invited/,
  );
  // The manager is always eligible.
  const managerSplit = plan("alice", "split", "freserve", { quantity: "1" });
  assert.equal(args(managerSplit).eligibility.policy, "invites");
});

test("factory markets are managed by factory admins, not the protocol root", () => {
  assert.throws(
    () => plan("alice", "close", "fmarket", { reason: "x" }),
    /through its factory/,
  );
  assert.throws(
    () => plan("alice", "propose", "fmarket", {}),
    /through its factory/,
  );
  const close = plan("bob", "factoryClose", "fmarket", { reason: "Paused" });
  assert.equal(close.command.ExerciseCommand.choice, "Binary_FactoryClose");
  assert.equal(args(close).roles, "factory-cid");
  assert.throws(
    () => plan("carol", "factoryClose", "fmarket", { reason: "x" }),
    /Admin of this market's factory/,
  );
  assert.throws(
    () => plan("alice", "factoryClose", "market", { reason: "x" }),
    /protocol root/,
  );
});

test("invite lists are created under the policy and edited by their manager", () => {
  const p = plan("alice", "createInviteList", "factory-cid", {
    parties: ["carol", "dave"],
  });
  assert.equal(
    p.command.ExerciseCommand.choice,
    "OutcomiaFactory_CreateInviteList",
  );
  assert.deepEqual(args(p), { manager: "alice", parties: ["carol", "dave"] });
  assert.throws(
    () =>
      plan("alice", "createInviteList", "factory-cid", { parties: ["x", "x"] }),
    /unique/,
  );
  const edit = plan("alice", "setInvites", "invites", { parties: ["erin"] });
  assert.equal(edit.command.ExerciseCommand.choice, "InviteList_Set");
  assert.throws(
    () => plan("carol", "setInvites", "invites", { parties: [] }),
    /manager/,
  );
});

test("creation fails closed without the factory package", () => {
  const unconfigured = { ...snapshot, deployment: base };
  assert.throws(
    () =>
      buildPlan("alice", unconfigured, owned, {
        action: "factoryCreate",
        target: "factory-cid",
        values: { terms: standard },
      }),
    /factory package/,
  );
});
