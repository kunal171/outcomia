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
const d = {
  packageId: "a".repeat(64),
  network: "canton:testnet",
  operator: "operator",
  vault: "vault",
  namespace: "outcomia",
  synchronizerId: "sync",
  trading: true,
};
const instrument = { admin: "issuer", id: "USD" },
  key = { operator: d.operator, protocolName: d.namespace, marketId: "1" };
const terms = {
  question: "Will the booster launch twice?",
  collateral: instrument,
  priceTick: "0.01",
  quantityLot: "1",
  closeAt: "2099-01-01T00:00:00Z",
  earliestResolutionAt: null,
  fallback: null,
  resolutionDelaySeconds: "3600",
  rules: {
    yesCriteria: "Two launches",
    noCriteria: "No second launch",
    invalidCriteria: "No evidence",
    evidenceRequirements: "Official records",
    documentUri: "https://example.com/rules",
    documentSha256: "a".repeat(64),
  },
};
const c = (kind, id, data) => ({
  kind,
  id,
  templateId: templateId(d, kind),
  data,
  blob: "YmxvYg==",
});
const policy = c("Protocol", "policy", {
  operator: d.operator,
  protocolName: d.namespace,
  admins: [d.operator, "alice"],
  takerFeeBps: "25",
  feeRevision: "3",
});
const market = c("BinaryMarket", "market", {
  ...key,
  creator: "alice",
  terms,
  status: "Open",
  createdAt: "2026-01-01T00:00:00Z",
  openedAt: "2026-01-01T00:00:00Z",
});
const book = c("OrderBook", "book", {
  key,
  vault: d.vault,
  creator: "alice",
  terms,
  factory: "factory",
  assetDecimals: "6",
  orders: [],
  fees: { amount: "0", cash: null },
});
const balance = c("AssetBalance", "balance", {
  ...key,
  owner: "alice",
  vault: d.vault,
  instrument,
  factory: "factory",
  available: "5",
  cash: "cash",
});
const position = c("PositionLot", "position", {
  key,
  vault: d.vault,
  owner: "alice",
  yes: "5",
  no: "5",
});
const admission = c("AssetAdmission", "admission", {
  operator: d.operator,
  instrument,
  factory: "factory",
  assetDecimals: "6",
});
const roots = ["VaultAuthority", "PositionRegistry", "OrderRegistry"].map((k) =>
  c(k, k, {
    operator: d.operator,
    vault: d.vault,
    protocolName: d.namespace,
    accounts: [],
    marketIds: [],
  }),
);
const snapshot = {
  deployment: d,
  contracts: [policy, market, book, admission, ...roots],
  quotes: [],
};
const owned = [balance, position];
const event = (x) => ({
  contractEntry: {
    JsActiveContract: {
      createdEvent: {
        contractId: x.id,
        templateId: x.templateId,
        createArgument: x.data,
        createdEventBlob: x.blob,
      },
    },
  },
});

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
