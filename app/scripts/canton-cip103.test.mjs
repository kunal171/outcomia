// CIP-0103 client: prepareExecute + txChanged lifecycle, standard error codes,
// ledgerApi requests and the Console Wallet provider adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Cip103Error,
  cip103Message,
  executePrepared,
  ledgerApi,
} from "../lib/canton/cip103.ts";
import { consoleProvider } from "../lib/console-wallet.ts";

/** A provider whose prepareExecute schedules the given txChanged events. */
function fakeProvider(events, { fail } = {}) {
  const listeners = new Map();
  const calls = [];
  const provider = {
    async request(args) {
      calls.push(args);
      if (fail) throw fail;
      queueMicrotask(() =>
        events.forEach((e) =>
          [...(listeners.get("txChanged") ?? [])].forEach((l) => l(e)),
        ),
      );
      return null;
    },
    on(event, listener) {
      listeners.set(
        event,
        new Set([...(listeners.get(event) ?? []), listener]),
      );
      return provider;
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
      return provider;
    },
  };
  return { provider, calls, listeners };
}

const executed = (commandId, updateId = "update-1") => ({
  status: "executed",
  commandId,
  payload: { updateId, completionOffset: 7 },
});

test("prepareExecute resolves only on the executed event of its own command", async () => {
  const { provider, calls, listeners } = fakeProvider([
    { status: "pending", commandId: "cmd-1" },
    executed("someone-else"),
    {
      status: "signed",
      commandId: "cmd-1",
      payload: { signature: "s", signedBy: "k", party: "p" },
    },
    executed("cmd-1"),
  ]);
  const tx = await executePrepared(provider, {
    commandId: "cmd-1",
    commands: [],
  });
  assert.equal(tx.payload.updateId, "update-1");
  assert.deepEqual(calls[0], {
    method: "prepareExecute",
    params: { commandId: "cmd-1", commands: [] },
  });
  assert.equal(listeners.get("txChanged").size, 0, "listener removed");
});

test("failed events, provider errors and silence reject without retrying", async () => {
  const failed = fakeProvider([{ status: "failed", commandId: "cmd-2" }]);
  await assert.rejects(
    executePrepared(failed.provider, { commandId: "cmd-2" }),
    (e) => e instanceof Cip103Error && e.code === -32003,
  );
  const rejected = fakeProvider([], { fail: { code: 4001, message: "no" } });
  await assert.rejects(
    executePrepared(rejected.provider, { commandId: "cmd-3" }),
    (e) => e.code === 4001,
  );
  const silent = fakeProvider([]);
  await assert.rejects(
    executePrepared(silent.provider, { commandId: "cmd-4" }, 20),
    /may still execute/,
  );
  assert.equal(silent.calls.length, 1);
  const unconfirmed = fakeProvider([
    { status: "executed", commandId: "cmd-5", payload: {} },
  ]);
  await assert.rejects(
    executePrepared(unconfirmed.provider, { commandId: "cmd-5" }),
    /not confirmed/,
  );
});

test("every standard error code maps to a clear message", () => {
  assert.equal(
    cip103Message({ code: 4001 }),
    "You rejected the request in your wallet.",
  );
  for (const code of [
    4100, 4200, 4900, 4901, -32700, -32600, -32601, -32602, -32603, -32000,
    -32001, -32002, -32003, -32004, -32005,
  ])
    assert.ok(cip103Message({ code }), `code ${code}`);
  assert.equal(
    cip103Message({ code: -32003, message: "Insufficient funds" }),
    "The transaction was rejected. Insufficient funds",
  );
  assert.equal(cip103Message({ code: 1234 }), null);
  assert.equal(cip103Message(new Error("plain")), null);
});

test("ledgerApi uses lowercase methods and sends a body only for posts", async () => {
  const { provider, calls } = fakeProvider([]);
  await ledgerApi(provider, "/v2/state/ledger-end");
  await ledgerApi(provider, "/v2/state/active-contracts", { a: 1 });
  assert.deepEqual(
    calls.map((c) => c.params),
    [
      { requestMethod: "get", resource: "/v2/state/ledger-end" },
      {
        requestMethod: "post",
        resource: "/v2/state/active-contracts",
        body: { a: 1 },
      },
    ],
  );
});

test("Console Wallet is driven through the standard provider", async () => {
  const log = [];
  const subscribers = new Map();
  const subscribe =
    (kind) =>
    ({ id }, listener) => {
      subscribers.set(id, { kind, listener });
      return () => subscribers.delete(id);
    };
  const wallet = {
    checkExtensionAvailability: async () => ({ status: "installed" }),
    connect: async (opts) => (
      log.push(["connect", opts]),
      { isConnected: true }
    ),
    disconnect: async () => log.push(["disconnect"]),
    isConnected: async () => ({ isConnected: true }),
    status: async () => ({ connection: { isConnected: true } }),
    getActiveNetwork: async () => ({ networkId: "canton:testnet" }),
    getPrimaryAccount: async () => ({ partyId: "alice::1", publicKey: "key" }),
    getAccounts: async () => [{ partyId: "alice::1" }],
    signMessage: async (m) => m,
    prepareExecute: async (p) => (
      log.push(["prepareExecute", p.commandId]),
      undefined
    ),
    ledgerAuth: async (a) => (
      log.push(["ledgerAuth", a.partyId, a.network]),
      { accessToken: "secret" }
    ),
    ledgerApi: async (r) => {
      log.push([
        "ledgerApi",
        r.requestMethod,
        r.resource,
        r.body,
        r.accessToken,
      ]);
      return { response: JSON.stringify({ offset: "12" }) };
    },
    onTxStatusChanged: subscribe("tx"),
    onAccountsChanged: subscribe("accounts"),
    onConnectionStatusChanged: subscribe("status"),
  };
  const provider = consoleProvider(wallet, "CANTON_NETWORK_TEST");
  assert.deepEqual(await provider.request({ method: "connect" }), {
    isConnected: true,
  });
  assert.equal(
    (await provider.request({ method: "getPrimaryAccount" })).partyId,
    "alice::1",
  );
  assert.equal(
    await provider.request({
      method: "prepareExecute",
      params: { commandId: "c" },
    }),
    null,
  );
  // ledgerApi: standard request in, token handled inside, parsed JSON out.
  assert.deepEqual(
    await provider.request({
      method: "ledgerApi",
      params: { requestMethod: "post", resource: "/v2/x", body: { a: 1 } },
    }),
    { offset: "12" },
  );
  assert.deepEqual(log.at(-1), [
    "ledgerApi",
    "POST",
    "/v2/x",
    '{"a":1}',
    "secret",
  ]);
  await assert.rejects(
    provider.request({ method: "getLedgerSecrets" }),
    (e) => e.code === 4200,
  );
  // Events: one subscription per listener, removed on removeListener.
  const seen = [];
  const listener = (e) => seen.push(e);
  provider.on("txChanged", listener).on("txChanged", listener);
  provider.on("accountsChanged", listener);
  assert.equal(subscribers.size, 2);
  [...subscribers.values()]
    .find((s) => s.kind === "tx")
    .listener(executed("c"));
  assert.equal(seen.length, 1);
  provider.removeListener("txChanged", listener);
  provider.removeListener("accountsChanged", listener);
  assert.equal(subscribers.size, 0);
  // Not installed → standard Disconnected error.
  const missing = consoleProvider(
    {
      ...wallet,
      checkExtensionAvailability: async () => ({ status: "notInstalled" }),
    },
    "CANTON_NETWORK_TEST",
  );
  await assert.rejects(
    missing.request({ method: "connect" }),
    (e) => e.code === 4900,
  );
});
