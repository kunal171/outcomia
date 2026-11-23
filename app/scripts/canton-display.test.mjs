import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalAmount,
  formatCantonAmount,
  parseHoldingAssets,
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

test("Token Standard holdings group by instrument with exact unlocked and locked totals", () => {
  const holding = (amount, instrument, owner = "alice::1", lock = null) => ({
    contractEntry: {
      JsActiveContract: {
        createdEvent: {
          interfaceViews: [
            {
              interfaceId: "pkg:Splice.Api.Token.HoldingV2:Holding",
              viewValue: {
                owner,
                account: { owner, provider: null, id: "" },
                instrumentId: instrument,
                amount,
                lock,
              },
            },
          ],
        },
      },
    },
  });
  const amulet = { admin: "dso::1220", id: "Amulet" },
    usd = { admin: "issuer::1220", id: "USD" };
  const assets = parseHoldingAssets(
    [
      holding("18446744073709551615.1234567890", usd),
      holding("2.5", amulet),
      holding("1", amulet),
      holding("0.5", amulet, "alice::1", { holders: [] }),
      holding("9", amulet, "bob::2"),
    ],
    "alice::1",
  );
  assert.deepEqual(assets, [
    {
      id: JSON.stringify(["issuer::1220", "USD"]),
      symbol: "USD",
      name: "USD",
      amount: "18446744073709551615.123456789",
      locked: "0",
    },
    {
      id: JSON.stringify(["dso::1220", "Amulet"]),
      symbol: "CC",
      name: "Canton Coin",
      amount: "3.5",
      locked: "0.5",
    },
  ]);
  assert.deepEqual(parseHoldingAssets({ items: [] }, "alice::1"), []);
  for (const bad of [null, {}, { items: "x" }])
    assert.throws(() => parseHoldingAssets(bad, "alice::1"));
  assert.throws(() => parseHoldingAssets([holding("NaN", usd)], "alice::1"));
  assert.throws(() =>
    parseHoldingAssets([holding("1", { admin: 1, id: "USD" })], "alice::1"),
  );
});
