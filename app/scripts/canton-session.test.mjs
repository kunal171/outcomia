import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifySession,
  verifyLoopSession,
  configuredNetwork,
} from "../lib/canton-session.ts";
const status = {
  connection: { isConnected: true, isNetworkConnected: true },
  network: { networkId: "canton:devnet" },
};
const account = {
  partyId: "alice::1220abcdef",
  status: "allocated",
  primary: true,
  networkId: "CANTON_NETWORK_DEV",
};
const network = { networkId: "canton:devnet" };

test("accepts only the live primary party on the configured Canton network", () => {
  assert.deepEqual(verifySession(status, account, network, "canton:devnet"), {
    chain: "canton",
    wallet: "console",
    partyId: account.partyId,
    networkId: "canton:devnet",
  });
});
test("rejects a connection without active network access", () => {
  assert.throws(
    () =>
      verifySession(
        { connection: { isConnected: false } },
        account,
        network,
        "canton:devnet",
      ),
    /not connected/,
  );
  assert.throws(
    () =>
      verifySession(
        { connection: { isConnected: true, isNetworkConnected: false } },
        account,
        network,
        "canton:devnet",
      ),
    /not connected/,
  );
});
test("does not infer a Canton session from an unallocated, non-primary or malformed account", () => {
  for (const candidate of [
    undefined,
    { ...account, status: "initialized" },
    { ...account, primary: false },
    { ...account, partyId: "solana-wallet-address" },
  ]) {
    assert.throws(() =>
      verifySession(status, candidate, network, "canton:devnet"),
    );
  }
});
test("rejects contradictory wallet network responses and unexpected mainnet", () => {
  assert.throws(
    () =>
      verifySession(
        status,
        account,
        { networkId: "canton:mainnet" },
        "canton:devnet",
      ),
    /Switch Console Wallet/,
  );
  assert.throws(
    () =>
      verifySession(
        status,
        { ...account, networkId: "CANTON_NETWORK" },
        network,
        "canton:devnet",
      ),
    /Switch Console Wallet/,
  );
  assert.throws(
    () =>
      verifySession(
        { ...status, network: { networkId: "canton:mainnet" } },
        account,
        network,
        "canton:devnet",
      ),
    /Switch Console Wallet/,
  );
});
test("requires explicit valid network configuration", () => {
  assert.equal(configuredNetwork(), "canton:testnet");
  assert.equal(configuredNetwork("canton:devnet"), "canton:devnet");
  assert.equal(configuredNetwork("canton:testnet"), "canton:testnet");
  for (const value of ["devnet", "solana:devnet", "", "canton:unknown"])
    assert.throws(() => configuredNetwork(value));
});

test("Loop identity requires live health, matching network and enabled primary party", () => {
  const loopAccount = { ...account, networkId: "canton:devnet" };
  assert.equal(
    verifyLoopSession(status, loopAccount, "canton:devnet").wallet,
    "loop",
  );
  for (const candidate of [
    undefined,
    { ...loopAccount, disabled: true },
    { ...loopAccount, primary: false },
    { ...loopAccount, status: "removed" },
    { ...loopAccount, networkId: "canton:mainnet" },
    { ...loopAccount, partyId: "bad" },
  ])
    assert.throws(() => verifyLoopSession(status, candidate, "canton:devnet"));
  for (const candidate of [
    { ...status, network: undefined },
    { ...status, network: { networkId: "canton:mainnet" } },
    { ...status, connection: { isConnected: false, isNetworkConnected: true } },
    { ...status, connection: { isConnected: true, isNetworkConnected: false } },
  ])
    assert.throws(() =>
      verifyLoopSession(candidate, loopAccount, "canton:devnet"),
    );
});

test("testnet Loop sessions reject devnet account/status combinations", () => {
  const testnetStatus = { ...status, network: { networkId: "canton:testnet" } };
  const testnetAccount = { ...account, networkId: "canton:testnet" };
  assert.deepEqual(
    verifyLoopSession(testnetStatus, testnetAccount, "canton:testnet"),
    {
      chain: "canton",
      wallet: "loop",
      partyId: account.partyId,
      networkId: "canton:testnet",
    },
  );
  for (const [networkStatus, party] of [
    [status, { ...account, networkId: "canton:devnet" }],
    [status, testnetAccount],
    [testnetStatus, { ...account, networkId: "canton:devnet" }],
  ])
    assert.throws(
      () => verifyLoopSession(networkStatus, party, "canton:testnet"),
      /testnet/,
    );
});

test("Console also verifies the shared Canton testnet target", () => {
  const testnetStatus = { ...status, network: { networkId: "canton:testnet" } };
  const active = { networkId: "canton:testnet" };
  const testnetAccount = { ...account, networkId: "CANTON_NETWORK_TEST" };
  assert.equal(
    verifySession(testnetStatus, testnetAccount, active, "canton:testnet")
      .networkId,
    "canton:testnet",
  );
  assert.throws(
    () => verifySession(testnetStatus, account, active, "canton:testnet"),
    /testnet/,
  );
});
