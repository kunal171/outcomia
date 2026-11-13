import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../lib/canton/commands.ts";
import {
  decodeContracts,
  orderQuote,
  marketKey,
  obj,
  templateId,
} from "../lib/canton/model.ts";
import { catalog, registryContext, deployment } from "../lib/canton/server.ts";
import { selectInputs } from "../lib/canton/holdings.ts";
import { executeWallet } from "../lib/canton/wallet-flow.ts";
import {
  d,
  instrument,
  key,
  terms,
  c,
  policy,
  market,
  book,
  balance,
  position,
  admission,
  roots,
  snapshot,
  owned,
  event,
} from "./fixtures/canton.mjs";

test("buy command binds owner, exact fee quote and current IDs without numeric conversion", () => {
  const p = buildPlan("alice", snapshot, owned, {
    action: "buy",
    target: "book",
    values: { price: "0.60", quantity: "5", outcome: "Yes" },
  });
  assert.equal(p.command.ExerciseCommand.choice, "OrderBook_PlaceBuy");
  assert.deepEqual(p.command.ExerciseCommand.choiceArgument.expectedFeeTerms, {
    takerFeeBps: "25",
    assetDecimals: "6",
  });
  assert.equal(p.command.ExerciseCommand.choiceArgument.owner, "alice");
  assert.equal(p.command.ExerciseCommand.choiceArgument.feePolicy, "policy");
  assert.equal(orderQuote("0.60", "5", "0.01", "1", "25", "6").debit, "3.0075");
});
test("rejects fee-underfunded, wrong-owner, off-tick/off-lot and unsafe price input", () => {
  assert.throws(() =>
    buildPlan("bob", snapshot, owned, {
      action: "withdraw",
      target: "balance",
      values: { amount: "1" },
    }),
  );
  assert.throws(() =>
    buildPlan("alice", snapshot, owned, {
      action: "buy",
      target: "book",
      values: { price: "0.5", quantity: "10" },
    }),
  );
  for (const [p, q, t, l] of [
    ["0.405", "1", "0.01", "1"],
    ["0.4", "3", "0.01", "2"],
    ["1", "1", "0.01", "1"],
  ])
    assert.throws(() => orderQuote(p, q, t, l, "25", "6"));
});
test("large quantities preserve exact decimal strings", () => {
  assert.equal(
    orderQuote("0.5", "9007199254740993", "0.01", "1", "0", "6").gross,
    "4503599627370496.5",
  );
});
test("cancellation needs an indexed owned order but no active market", () => {
  const order = c("LimitOrder", "order", {
    key,
    owner: "alice",
    instrument,
    factory: "factory",
    side: "Buy",
    price: "0.4",
    quantity: "1",
  });
  const b = { ...book, data: { ...book.data, orders: [{ order: "order" }] } };
  const p = buildPlan(
    "alice",
    { ...snapshot, contracts: [policy, b] },
    [...owned, order],
    { action: "cancel", target: "order" },
  );
  assert.equal(p.command.ExerciseCommand.choiceArgument.balance, "balance");
});
test("claim batch is bounded and pinned to one owner and market", () => {
  const reserve = c("SettledReserve", "settled", {
    key,
    vault: d.vault,
    terms,
    factory: "factory",
    outcome: "YesWins",
  });
  const p = buildPlan(
    "alice",
    { ...snapshot, contracts: [...snapshot.contracts, reserve] },
    owned,
    { action: "redeem", target: "settled" },
  );
  assert.deepEqual(p.command.ExerciseCommand.choiceArgument.positions, [
    "position",
  ]);
});
test("operator choices cannot be requested by ordinary wallet", () => {
  assert.throws(() =>
    buildPlan("alice", snapshot, owned, {
      action: "withdrawFees",
      target: "book",
      values: { amount: "1" },
    }),
  );
  assert.throws(() =>
    buildPlan("alice", snapshot, owned, {
      action: "setFee",
      target: "policy",
      values: { amount: "25" },
    }),
  );
});
test("malformed ACS is an error and foreign package/namespace are not shown", () => {
  assert.throws(() => decodeContracts({}, d));
  assert.throws(() => decodeContracts([{}], d));
  const bad = c("AssetBalance", "foreign", {
    ...balance.data,
    protocolName: "other",
  });
  assert.deepEqual(decodeContracts([event(bad)], d), []);
  assert.equal(
    decodeContracts([event(admission)], d)[0].kind,
    "AssetAdmission",
  );
});
test("private wallet holdings reject locks, foreign ownership and wrong instruments", () => {
  const holding = (id, owner, lock, asset = instrument) => ({
    contractEntry: {
      JsActiveContract: {
        createdEvent: {
          contractId: id,
          templateId: "registry:Holding:Holding",
          createdEventBlob: "YmxvYg==",
          interfaceViews: [
            {
              interfaceId: "hash:Splice.Api.Token.HoldingV2:Holding",
              viewValue: {
                account: { owner, provider: null, id: "" },
                instrumentId: asset,
                amount: "3.25",
                lock,
              },
            },
          ],
        },
      },
    },
  });
  const selected = selectInputs(
    [
      holding("a", "bob", null),
      holding("b", "alice", {}),
      holding("c", "alice", null, { admin: "other", id: "USD" }),
      holding("d", "alice", null),
    ],
    "alice",
    instrument,
    "2",
  );
  assert.deepEqual(selected.inputs, ["d"]);
  assert.throws(() =>
    selectInputs([holding("b", "alice", {})], "alice", instrument, "1"),
  );
});
const env = {
  CANTON_PACKAGE_ID: d.packageId,
  CANTON_OPERATOR_PARTY: d.operator,
  CANTON_VAULT_PARTY: d.vault,
  CANTON_PROTOCOL_NAME: d.namespace,
  CANTON_SYNCHRONIZER_ID: d.synchronizerId,
  CANTON_JSON_API_URL: "https://ledger.example",
  CANTON_CATALOG_TOKEN: "test-secret",
  NEXT_PUBLIC_CANTON_NETWORK_ID: d.network,
  CANTON_TRADING_ENABLED: "true",
  CANTON_REGISTRY_CONTEXT_URL: "https://registry.example/context",
};
test("unconfigured deployment fails closed without a network request", async () => {
  assert.equal(deployment({}), null);
  assert.equal(
    await catalog({}, () => {
      throw Error("must not fetch");
    }),
    null,
  );
});
test("public catalog queries a fixed operator and redacts private contracts", async () => {
  const calls = [];
  const out = await catalog(env, async (url, init) => {
    calls.push([String(url), init]);
    return Response.json(
      String(url).endsWith("ledger-end")
        ? { offset: "100" }
        : [...snapshot.contracts, balance, position].map(event),
    );
  });
  assert.ok(out);
  assert.ok(
    !out.contracts.some((c) =>
      ["AssetBalance", "PositionLot", "LimitOrder"].includes(c.kind),
    ),
  );
  assert.ok(!JSON.stringify(out).includes("test-secret"));
  const body = JSON.parse(calls[1][1].body);
  assert.deepEqual(Object.keys(body.eventFormat.filtersByParty), ["operator"]);
});
test("context adapter binds party, network and instrument without signing", async () => {
  const req = {
    party: "alice",
    action: "deposit",
    instrument,
    contractIds: ["balance"],
    command: {
      ExerciseCommand: {
        templateId: balance.templateId,
        contractId: "balance",
        choice: "AssetBalance_Deposit",
        choiceArgument: { owner: "alice" },
      },
    },
  };
  const good = {
    party: "alice",
    network: d.network,
    instrument: { id: "USD", admin: "issuer" },
    extraArgs: { context: { values: [] }, meta: { values: {} } },
    disclosedContracts: [],
  };
  assert.equal(
    (await registryContext(env, req, async () => Response.json(good))).party,
    "alice",
  );
  await assert.rejects(() =>
    registryContext(env, req, async () =>
      Response.json({ ...good, network: "canton:mainnet" }),
    ),
  );
});
const session = {
  chain: "canton",
  wallet: "loop",
  partyId: "alice",
  networkId: d.network,
};
const command = buildPlan("alice", snapshot, owned, {
  action: "buy",
  target: "book",
  values: { price: "0.6", quantity: "1" },
}).command;
test("wallet submission pins actAs/readAs and accepts only matching executed receipt", async () => {
  let sent;
  const id = await executeWallet(
    session,
    d,
    command,
    [],
    async () => session,
    async (request) => {
      sent = request;
      return {
        tx: {
          status: "executed",
          commandId: request.commandId,
          payload: { updateId: "update-1" },
        },
      };
    },
  );
  assert.equal(id, "update-1");
  assert.deepEqual(sent.actAs, ["alice"]);
  assert.deepEqual(sent.readAs, ["alice"]);
});
test("wallet switch during approval rejects the old confirmation", async () => {
  let reads = 0;
  await assert.rejects(
    () =>
      executeWallet(
        session,
        d,
        command,
        [],
        async () => (++reads === 1 ? session : { ...session, partyId: "bob" }),
        async (request) => ({
          tx: {
            status: "executed",
            commandId: request.commandId,
            payload: { updateId: "update" },
          },
        }),
      ),
    /Wallet changed/,
  );
});
test("unconfirmed/mismatched receipts and disabled deployments never become success", async () => {
  await assert.rejects(() =>
    executeWallet(
      session,
      d,
      command,
      [],
      async () => session,
      async () => ({
        tx: {
          status: "executed",
          commandId: "wrong",
          payload: { updateId: "update" },
        },
      }),
    ),
  );
  await assert.rejects(() =>
    executeWallet(
      session,
      { ...d, trading: false },
      command,
      [],
      async () => session,
      async () => {
        throw Error("must not submit");
      },
    ),
  );
});

test("creator setup, funding and complete-set commands bind current roots", () => {
  const reserve = c("MarketReserve", "reserve", {
    key,
    vault: d.vault,
    creator: "alice",
    terms,
    factory: "factory",
    assetDecimals: "6",
  });
  const view = { ...snapshot, contracts: [...snapshot.contracts, reserve] };
  const cases = [
    ["enroll", "admission", {}, "VaultAuthority_OpenBalance"],
    ["deposit", "balance", { amount: "1.25" }, "AssetBalance_Deposit"],
    ["withdraw", "balance", { amount: "1.25" }, "AssetBalance_Withdraw"],
    ["split", "reserve", { quantity: "2" }, "MarketReserve_Split"],
    ["merge", "reserve", { quantity: "2" }, "MarketReserve_Merge"],
    [
      "sell",
      "book",
      { price: "0.4", quantity: "2", outcome: "No" },
      "OrderBook_PlaceSell",
    ],
    ["create", "policy", { terms }, "Protocol_CreateBinary"],
    ["reserve", "market", {}, "PositionRegistry_CreateReserve"],
    ["book", "market", {}, "OrderRegistry_CreateBook"],
    ["open", "market", {}, "Binary_Open"],
    ["close", "market", { reason: "Admin closed" }, "Binary_Close"],
    ["cancelDraft", "market", {}, "Binary_CancelDraft"],
  ];
  for (const [action, target, values, choice] of cases) {
    const plan = buildPlan("alice", view, owned, { action, target, values });
    assert.equal(plan.command.ExerciseCommand.choice, choice);
    assert.ok(
      plan.dependencies.includes(plan.command.ExerciseCommand.contractId),
    );
  }
});

test("resolution commands preserve evidence, roles, deadlines and final binding", () => {
  const past = { ...terms, closeAt: "2020-01-01T00:00:00Z" };
  const closed = {
    ...market,
    data: { ...market.data, terms: past, status: "Closed" },
  };
  const pending = c("ResolutionProposal", "proposal", {
    key,
    creator: "alice",
    terms: past,
    finalizableAt: "2099-01-01T00:00:00Z",
  });
  const evidence = {
    summary: "Official result",
    documentUri: "https://example.com/evidence",
    documentSha256: "b".repeat(64),
  };
  const view = { ...snapshot, contracts: [policy, closed, pending] };
  for (const [action, target] of [
    ["propose", "market"],
    ["correct", "proposal"],
  ]) {
    const plan = buildPlan("alice", view, owned, {
      action,
      target,
      values: { outcome: "YesWins", evidence },
    });
    assert.deepEqual(
      plan.command.ExerciseCommand.choiceArgument[
        action === "correct" ? "replacementEvidence" : "evidence"
      ],
      evidence,
    );
  }
  assert.throws(
    () =>
      buildPlan("operator", view, [], {
        action: "finalize",
        target: "proposal",
      }),
    /delay/,
  );
  pending.data.finalizableAt = "2020-01-01T01:00:00Z";
  assert.equal(
    buildPlan("operator", view, [], { action: "finalize", target: "proposal" })
      .command.ExerciseCommand.choice,
    "ResolutionProposal_Finalize",
  );
  assert.throws(
    () =>
      buildPlan("alice", view, owned, {
        action: "correct",
        target: "proposal",
        values: { outcome: "NoWins", evidence },
      }),
    /closed/,
  );
  const reserve = c("MarketReserve", "reserve", { key, terms: past });
  const final = c("FinalResolution", "final", {
    proposal: { key, terms: past, creator: "alice" },
  });
  const binding = buildPlan(
    "operator",
    { ...view, contracts: [...view.contracts, reserve, final] },
    [],
    { action: "bind", target: "reserve" },
  );
  assert.equal(
    binding.command.ExerciseCommand.choiceArgument.resolution,
    "final",
  );
});

test("operator matching chooses price and FIFO and supplies both owner balances", () => {
  const orders = [
    c("LimitOrder", "bid", {
      key,
      owner: "alice",
      outcome: "Yes",
      side: "Buy",
      price: "0.6",
      quantity: "2",
      orderId: "3",
    }),
    c("LimitOrder", "ask-first", {
      key,
      owner: "bob",
      outcome: "Yes",
      side: "Sell",
      price: "0.4",
      quantity: "1",
      orderId: "1",
    }),
    c("LimitOrder", "ask-second", {
      key,
      owner: "carol",
      outcome: "Yes",
      side: "Sell",
      price: "0.4",
      quantity: "1",
      orderId: "2",
    }),
  ];
  const b = {
    ...book,
    data: { ...book.data, orders: orders.map((o) => ({ order: o.id })) },
  };
  const accounts = [
    balance,
    ...["bob", "carol"].map((owner) =>
      c("AssetBalance", owner + "-balance", { ...balance.data, owner }),
    ),
  ];
  const plan = buildPlan(
    "operator",
    { ...snapshot, contracts: [policy, market, b] },
    [...orders, ...accounts],
    { action: "match", target: "book", values: { outcome: "Yes" } },
  );
  assert.equal(
    plan.command.ExerciseCommand.choiceArgument.buyerBalance,
    "balance",
  );
  assert.equal(
    plan.command.ExerciseCommand.choiceArgument.sellerBalance,
    "bob-balance",
  );
  assert.throws(
    () =>
      buildPlan(
        "operator",
        { ...snapshot, contracts: [policy, market, b] },
        accounts,
        { action: "match", target: "book" },
      ),
    /Incomplete/,
  );
});

test("malformed final outcomes cannot be displayed as refundable invalid results", () => {
  const bad = c("SettledReserve", "bad-final", {
    key,
    vault: d.vault,
    outcome: "Unknown",
  });
  assert.throws(() => decodeContracts([event(bad)], d), /outcome/);
});
