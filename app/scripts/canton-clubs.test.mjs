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
  carol = "carol::3",
  // A protocol-root admin in the shared fixture's Protocol contract.
  admin = "alice";
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
  rules: {
    publicMemberCap: "256",
    privateMemberCap: "256",
    maxOwnedClubs: "2",
    maxClubAdmins: "5",
  },
  // DA.Map encodes as [key, value] pairs.
  owned: [[owner, "2"]],
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
  kind: "PublicClub",
  memberCap: "256",
  adminCap: "5",
  listing: null,
  requests: [],
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
  assert.deepEqual(args(p), {
    owner: carol,
    name: "Book club",
    kind: "PrivateClub",
  });
  assert.equal(
    args(
      plan(
        carol,
        "createClub",
        { name: "Fans", kind: "PublicClub" },
        "registry",
        [],
      ),
    ).kind,
    "PublicClub",
  );
  // The owner already owns the maximum (2) clubs.
  assert.throws(
    () => plan(owner, "createClub", { name: "Third" }, "registry", []),
    /maximum number of clubs/,
  );
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

test("only club-factory markets are club scoped; protocol markets never throw", async () => {
  const { clubScoped } = await import("../lib/canton/model.ts");
  const { market } = await import("./fixtures/canton.mjs");
  const ref = (factoryId) => ({
    operator: d.operator,
    namespace: d.namespace,
    factoryId,
  });
  const factory = (id, factoryId, policy) =>
    c("OutcomiaMarketFactory", id, { ref: ref(factoryId), policy });
  const contracts = [
    market,
    factory("club-f", "club-1", { tag: "ByPolicy", value: clubRef }),
    factory("open-f", "public", { tag: "AnyParty", value: {} }),
  ];
  // A protocol-root market has no issuing factory.
  assert.equal(clubScoped(contracts, market.data), false);
  assert.equal(
    clubScoped(contracts, { ...market.data, factory: ref("club-1") }),
    true,
  );
  assert.equal(
    clubScoped(contracts, { ...market.data, factory: ref("public") }),
    false,
  );
  // A scope whose factory is not in the catalog is not treated as a club market.
  assert.equal(
    clubScoped(contracts, { ...market.data, factory: ref("gone") }),
    false,
  );
});

test("the operator clears orders of wallets that left the club", () => {
  const order = (id, owner, side) =>
    c("LimitOrder", id, {
      key: scopedKey,
      vault: d.vault,
      owner,
      instrument,
      factory: balance.data.factory,
      outcome: "Yes",
      side,
      price: "0.4",
      quantity: "2",
      orderId: id === "carol-bid" ? "1" : "2",
    });
  const departed = order("carol-bid", carol, "Buy"),
    current = order("bob-ask", bob, "Sell");
  const book = c("OrderBook", "club-book", {
    key: scopedKey,
    vault: d.vault,
    creator: owner,
    terms,
    orders: [{ order: "carol-bid" }, { order: "bob-ask" }],
    fees: { amount: "0", cash: null },
  });
  const carolBalance = {
    ...balance,
    id: "carol-balance",
    data: { ...balance.data, owner: carol },
  };
  const view = { ...snapshot, contracts: [...snapshot.contracts, book] };
  const owned = [club, departed, current, carolBalance];
  const clear = (party, target) =>
    buildPlan(party, view, owned, { action: "clearDeparted", target });
  const p = clear(d.operator, "carol-bid");
  assert.equal(choice(p), "OrderBook_CancelIneligible");
  assert.equal(p.command.ExerciseCommand.contractId, "club-book");
  assert.equal(args(p).order, "carol-bid");
  assert.equal(args(p).policy, "club");
  assert.equal(args(p).balance, "carol-balance");
  // Bob is still a member, and only the operator clears.
  assert.throws(() => clear(d.operator, "bob-ask"), /can still trade/);
  assert.throws(() => clear(owner, "carol-bid"), /Operator wallet required/);
});

const listed = (visibility, verifiedBy = admin) => ({
  ...club,
  data: {
    ...club.data,
    listing: {
      visibility,
      topic: "Chess",
      description: "",
      verifiedBy,
      updatedAt: "2026-01-01T00:00:00Z",
    },
  },
});

test("ownership moves through the registry, which keeps owned counts", () => {
  const nominated = { ...club, data: { ...club.data, pendingOwner: bob } };
  const p = plan(bob, "clubAcceptOwnership", {}, "club", [nominated]);
  assert.equal(choice(p), "ClubRegistry_AcceptOwnership");
  assert.equal(p.command.ExerciseCommand.contractId, "registry");
  assert.deepEqual(args(p), {
    nominee: bob,
    club: "club",
    factory: "club-factory",
  });
});

test("owners list public clubs; root admins verify; private clubs never list", () => {
  assert.deepEqual(
    args(
      plan(owner, "clubSetListing", {
        visibility: "OpenToAll",
        topic: "Chess",
        description: "Puzzles",
      }),
    ),
    { visibility: "OpenToAll", topic: "Chess", description: "Puzzles" },
  );
  assert.throws(
    () => plan(bob, "clubSetListing", { topic: "Chess" }),
    /club owner/,
  );
  assert.throws(
    () => plan(owner, "clubSetListing", { topic: " pad" }),
    /Topics/,
  );
  const hidden = { ...club, data: { ...club.data, kind: "PrivateClub" } };
  assert.throws(
    () => plan(owner, "clubSetListing", { topic: "Chess" }, "club", [hidden]),
    /Only public clubs/,
  );
  const v = plan(admin, "clubVerifyListing", {}, "club", [
    listed("RequestToJoin", null),
  ]);
  assert.equal(choice(v), "Club_VerifyListing");
  assert.deepEqual(args(v), {
    verifier: admin,
    protocol: "policy",
    verified: true,
  });
  assert.throws(
    () =>
      plan(bob, "clubVerifyListing", {}, "club", [
        listed("RequestToJoin", null),
      ]),
    /administrator/,
  );
});

test("join requests and open joins follow the verified listing and caps", () => {
  const requestable = listed("RequestToJoin");
  assert.deepEqual(
    args(plan(carol, "clubRequestJoin", { note: "hi" }, "club", [requestable])),
    { requester: carol, note: "hi" },
  );
  assert.throws(
    () =>
      plan(carol, "clubRequestJoin", {}, "club", [
        listed("RequestToJoin", null),
      ]),
    /does not accept/,
  );
  assert.throws(
    () => plan(carol, "clubJoinOpen", {}, "club", [requestable]),
    /not open/,
  );
  const pending = {
    ...requestable,
    data: {
      ...requestable.data,
      requests: [
        { requester: "dave::4", note: "", expiresAt: "2099-01-01T00:00:00Z" },
      ],
    },
  };
  assert.equal(
    choice(
      plan(owner, "clubApproveRequest", { wallet: "dave::4" }, "club", [
        pending,
      ]),
    ),
    "Club_ApproveRequest",
  );
  assert.throws(
    () =>
      plan(bob, "clubApproveRequest", { wallet: "dave::4" }, "club", [pending]),
    /club admins/,
  );
  const full = { ...pending, data: { ...pending.data, memberCap: "2" } };
  assert.throws(
    () =>
      plan(owner, "clubApproveRequest", { wallet: "dave::4" }, "club", [full]),
    /member limit/,
  );
  assert.equal(
    choice(
      plan("dave::4", "clubCloseRequest", { wallet: "dave::4" }, "club", [
        pending,
      ]),
    ),
    "Club_CloseRequest",
  );
  const open = listed("OpenToAll");
  assert.deepEqual(args(plan(carol, "clubJoinOpen", {}, "club", [open])), {
    wallet: carol,
  });
  assert.throws(
    () => plan(bob, "clubJoinOpen", {}, "club", [open]),
    /already a member/,
  );
});

test("admins are capped and only the operator sets club rules", () => {
  const capped = { ...club, data: { ...club.data, adminCap: "1" } };
  assert.throws(
    () =>
      plan(owner, "clubSetAdmin", { wallet: bob, makeAdmin: "true" }, "club", [
        capped,
      ]),
    /maximum number of admins/,
  );
  const rules = {
    publicMemberCap: "200",
    privateMemberCap: "50",
    maxOwnedClubs: "3",
    maxClubAdmins: "4",
  };
  const p = plan(d.operator, "setClubRules", rules, "registry", []);
  assert.equal(choice(p), "ClubRegistry_SetRules");
  assert.deepEqual(args(p), { replacementRules: rules });
  assert.throws(
    () => plan(owner, "setClubRules", rules, "registry", []),
    /Operator wallet/,
  );
  assert.throws(
    () =>
      plan(
        d.operator,
        "setClubRules",
        { ...rules, publicMemberCap: "300" },
        "registry",
        [],
      ),
    /between 1 and 256/,
  );
  assert.equal(
    choice(plan(d.operator, "clubApplyRules", {})),
    "Club_ApplyRules",
  );
});
