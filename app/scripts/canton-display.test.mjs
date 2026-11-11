import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalAmount,
  formatCantonAmount,
  parseWalletAssets,
  previewCantonOrder,
} from "../lib/canton-display.ts";

const token = {
  id: "issuer::1220:USD",
  symbol: "USD",
  name: "Test dollar",
  balance: "18446744073709551615.1234567890",
  network: "CANTON_NETWORK_DEV",
};

test("wallet amounts retain exact integers and fractional digits in every locale", () => {
  assert.equal(canonicalAmount("000.000"), "0");
  assert.equal(
    canonicalAmount(token.balance),
    "18446744073709551615.123456789",
  );
  assert.equal(
    formatCantonAmount(token.balance, "en"),
    "18,446,744,073,709,551,615.123456789",
  );
  for (const locale of ["hi", "es", "fr", "pt"]) {
    assert.ok(formatCantonAmount(token.balance, locale).endsWith("123456789"));
  }
  for (const value of ["-1", "NaN", "Infinity", "1e20", "1,200", "", "0.1x"])
    assert.throws(() => canonicalAmount(value));
});

test("wallet responses reject invalid, duplicate and cross-network assets", () => {
  assert.deepEqual(parseWalletAssets({ tokens: [token] }, "canton:devnet"), [
    {
      id: token.id,
      symbol: "USD",
      name: "Test dollar",
      amount: "18446744073709551615.123456789",
    },
  ]);
  assert.deepEqual(parseWalletAssets({ tokens: [] }, "canton:devnet"), []);
  for (const response of [
    null,
    {},
    { tokens: "invalid" },
    { tokens: [null] },
    { tokens: [token, token] },
    { tokens: [{ ...token, balance: "NaN" }] },
    { tokens: [{ ...token, id: "" }] },
  ])
    assert.throws(() => parseWalletAssets(response, "canton:devnet"));
  assert.throws(
    () => parseWalletAssets({ tokens: [token] }, "canton:mainnet"),
    /another network/,
  );
});

test("order preview uses exact Daml Decimal arithmetic and Int bounds", () => {
  assert.equal(previewCantonOrder("0.40", "3"), "1.2");
  assert.equal(previewCantonOrder("0.0000000001", "1"), "0.0000000001");
  assert.equal(
    previewCantonOrder("0.9999999999", "9223372036854775807"),
    "9223372035932438603.3145224193",
  );
  for (const [price, quantity] of [
    ["", "3"],
    ["0", "3"],
    ["1", "3"],
    ["-0.4", "3"],
    ["0.12345678901", "1"],
    ["0,4", "3"],
    ["0.4", "0"],
    ["0.4", "1.2"],
    ["0.4", "9223372036854775808"],
  ])
    assert.equal(previewCantonOrder(price, quantity), null);
});
