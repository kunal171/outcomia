// Club commands: roster actions on the Club contract, club market creation
// with the club as creation proof, and club membership as trading proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../lib/canton/commands.ts";
import {
  d as base,
  instrument,
  terms,
  c,
  policy,
  balance,
  admission,
  roots,
} from "./fixtures/canton.mjs";

const d = { ...base, factoryPackageId: "f".repeat(64) };
const owner = "owner::1",
  bob = "bob::2",
  carol = "carol::3";
const clubRef = {
  operator: d.operator,
  namespace: d.namespace,
  policyId: "club/1",
};
const factoryRef = {
  operator: d.operator,
  namespace: d.namespace,
  factoryId: "club-1",
};
const registry = c("ClubRegistry", "registry", {
  operator: d.operator,
  vault: d.vault,
  protocolName: d.namespace,
  assets: [],
  nextClub: "2",
});
const club = c("Club", "club", {
  operator: d.operator,
  owner,
  name: "Chess club",
  admins: [owner],
  members: [owner, bob],
  invitations: [
    { invitee: carol, inviter: owner, expiresAt: "2099-01-01T00:00:00Z" },
  ],
  pendingOwner: null,
  marketPolicy: "AdminsOnly",
  ref: clubRef,
  factoryRef,
  createdAt: "2026-01-01T00:00:00Z",
});
const factory = c("OutcomiaMarketFactory", "club-factory", {
  operator: d.operator,
  vault: d.vault,
  protocolName: d.namespace,
  ref: factoryRef,
  admins: [owner],
  policy: { tag: "ByPolicy", value: clubRef },
  assets: [{ instrument, admission: "admission" }],
  nextNumber: "1",
  nextPolicyNumber: "1",
});
const scopedKey = {
  operator: d.operator,
  protocolName: d.namespace,
  marketId: "1",
  scope: factoryRef,
};
const market = c("BinaryMarket", "club-market", {
  operator: d.operator,
  protocolName: d.namespace,
  marketId: "1",
  creator: owner,
  terms,
  status: "Open",
  createdAt: "2026-01-01T00:00:00Z",
  openedAt: "2026-01-01T00:00:00Z",
  factory: factoryRef,
  access: clubRef,
});
const reserve = c("MarketReserve", "club-reserve", {
  key: scopedKey,
  vault: d.vault,
  creator: owner,
  terms,
  factory: "factory",
  assetDecimals: "6",
  completeSets: "0",
  cash: null,
});
const snapshot = {
  deployment: d,
  contracts: [policy, registry, factory, market, reserve, admission, ...roots],
  quotes: [],
};
const plan = (party, action, values, target = "club", owned = [club]) =>
  buildPlan(party, snapshot, owned, { action, target, values });
const args = (p) => p.command.ExerciseCommand.choiceArgument;
const choice = (p) => p.command.ExerciseCommand.choice;
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

test("any wallet creates a club through the registry", () => {
  const p = plan(carol, "createClub", { name: "Book club" }, "registry", []);
  assert.equal(choice(p), "ClubRegistry_CreateClub");
  assert.deepEqual(args(p), { owner: carol, name: "Book club" });
  assert.throws(
    () => plan(carol, "createClub", { name: " padded" }, "registry", []),
    /Club names/,
  );
});

test("invitations: admins invite, invitees accept or decline", () => {
  assert.equal(
    choice(plan(owner, "clubInvite", { wallet: "dave::4" })),
    "Club_Invite",
  );
  assert.throws(
    () => plan(bob, "clubInvite", { wallet: "dave::4" }),
    /club admins/,
  );
  assert.throws(
    () => plan(owner, "clubInvite", { wallet: bob }),
    /already a member/,
  );
  assert.throws(
    () => plan(owner, "clubInvite", { wallet: "not a party" }),
    /valid Canton party/,
  );
  const accept = plan(carol, "clubAccept", {});
  assert.deepEqual(
    [choice(accept), args(accept)],
    ["Club_Accept", { invitee: carol }],
  );
  assert.throws(() => plan(bob, "clubAccept", {}), /no invitation/);
  assert.equal(choice(plan(carol, "clubDecline", {})), "Club_Decline");
  assert.deepEqual(args(plan(owner, "clubRevoke", { wallet: carol })), {
    actor: owner,
    invitee: carol,
  });
  assert.throws(
    () => plan(owner, "clubClear", {}),
    /No invitation has expired/,
  );
});

test("roles, removal and leaving sync the club factory", () => {
  const promote = plan(owner, "clubSetAdmin", {
    wallet: bob,
    makeAdmin: "true",
  });
  assert.deepEqual(args(promote), {
    wallet: bob,
    makeAdmin: true,
    factory: "club-factory",
  });
  assert(promote.dependencies.includes("club-factory"));
  assert.throws(
    () => plan(bob, "clubSetAdmin", { wallet: bob, makeAdmin: "true" }),
    /club owner/,
  );
  assert.throws(
    () => plan(owner, "clubSetAdmin", { wallet: carol, makeAdmin: "true" }),
    /not a member/,
  );
  assert.equal(
    choice(plan(owner, "clubRemove", { wallet: bob })),
    "Club_RemoveMember",
  );
  assert.throws(
    () => plan(owner, "clubRemove", { wallet: owner }),
    /owner cannot be removed/,
  );
  assert.deepEqual(args(plan(bob, "clubLeave", {})), {
    wallet: bob,
    factory: "club-factory",
  });
  assert.throws(() => plan(owner, "clubLeave", {}), /Transfer ownership/);
  assert.deepEqual(args(plan(owner, "clubNominate", { wallet: bob })), {
    nominee: bob,
  });
  assert.deepEqual(args(plan(owner, "clubNominate", { wallet: "" })), {
    nominee: null,
  });
  assert.throws(() => plan(bob, "clubAcceptOwnership", {}), /nominated owner/);
});

test("club markets are created with the club as proof, members-only or public", () => {
  const p = plan(
    owner,
    "factoryCreate",
    { terms: standard, access: "club" },
    "club-factory",
  );
  assert.equal(choice(p), "MarketFactory_Create");
  assert.deepEqual(args(p).proof, { policy: "club", evidence: [] });
  assert.deepEqual(args(p).access, { tag: "Restricted", value: clubRef });
  const open = plan(
    owner,
    "factoryCreate",
    { terms: standard, access: "public" },
    "club-factory",
  );
  assert.deepEqual(args(open).access, { tag: "Public", value: {} });
  // Bob is a member, not an admin, under the admins-only policy.
  assert.throws(
    () => plan(bob, "factoryCreate", { terms: standard }, "club-factory"),
    /club admins/,
  );
  const anyMember = {
    ...club,
    data: { ...club.data, marketPolicy: "AnyMember" },
  };
  assert.equal(
    args(
      plan(bob, "factoryCreate", { terms: standard }, "club-factory", [
        anyMember,
      ]),
    ).proof.policy,
    "club",
  );
  assert.throws(
    () => plan(carol, "factoryCreate", { terms: standard }, "club-factory", []),
    /club members/,
  );
});

test("members-only club markets need the club as trading proof", () => {
  const bobBalance = {
    ...balance,
    id: "bob-balance",
    data: { ...balance.data, owner: bob },
  };
  const p = plan(bob, "split", { quantity: "1" }, "club-reserve", [
    club,
    bobBalance,
  ]);
  assert.deepEqual(args(p).eligibility, { policy: "club", evidence: [] });
  const carolBalance = {
    ...balance,
    id: "carol-balance",
    data: { ...balance.data, owner: carol },
  };
  assert.throws(
    () =>
      plan(carol, "split", { quantity: "1" }, "club-reserve", [
        club,
        carolBalance,
      ]),
    /club members/,
  );
});
