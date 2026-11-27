// Combined P&L: exact USD conversion, Pyth parsing and price sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atomsToUsd8,
  combinePnl,
  formatUsd8,
  parseHermes,
  pythDecimal,
} from "../lib/prices/usd.ts";
import { priceSources, DEFAULT_PRICE_SOURCES } from "../lib/prices/sources.ts";

test("Pyth prices are exact decimals", () => {
  assert.equal(pythDecimal("14250000000", -8), "142.5");
  assert.equal(pythDecimal("5", -3), "0.005");
  assert.equal(pythDecimal("12", 2), "1200");
  const now = 1_000_000;
  const prices = parseHermes(
    {
      parsed: [
        {
          id: "ab",
          price: { price: "14250000000", expo: -8, publish_time: now - 10 },
        },
        {
          id: "cd",
          price: { price: "100", expo: -2, publish_time: now - 1000 },
        },
      ],
    },
    now,
  );
  assert.deepEqual(Object.keys(prices), ["0xab"], "stale prices are dropped");
  assert.equal(prices["0xab"].usd, "142.5");
});

test("USD conversion is exact and rounds to cents", () => {
  // 1.5 SOL (9 decimals) at 142.5 = 213.75
  assert.equal(formatUsd8(atomsToUsd8("1500000000", 9, "142.5")), "213.75");
  assert.equal(formatUsd8(atomsToUsd8("-2500000", 6, "1")), "-2.50");
  assert.equal(formatUsd8(BigInt(-400000)), "0.00");
  assert.equal(formatUsd8(BigInt(500000)), "0.01");
});

test("totals add priced assets and list unpriced ones", () => {
  const rows = [
    {
      chain: "solana",
      asset: "solana:usdc",
      label: "USDC",
      decimals: 6,
      realized: "10000000",
      unrealized: "-2500000",
    },
    {
      chain: "solana",
      asset: "solana:sol",
      label: "SOL",
      decimals: 9,
      realized: "1000000000",
      unrealized: "0",
    },
    {
      chain: "canton",
      asset: "canton:CC",
      label: "CC",
      decimals: 10,
      realized: "5",
      unrealized: "0",
    },
  ];
  const result = combinePnl(rows, {
    "solana:usdc": { usd: "1", source: "fixed" },
    "solana:sol": { usd: "142.5", source: "pyth" },
  });
  assert.equal(result.totalUsd, "150.00");
  assert.deepEqual(
    result.priced.map((r) => r.usd),
    ["7.50", "142.50"],
  );
  assert.deepEqual(
    result.unpriced.map((r) => r.label),
    ["CC"],
  );
});

test("price source overrides are validated", () => {
  assert.equal(priceSources(undefined), DEFAULT_PRICE_SOURCES);
  const merged = priceSources(
    JSON.stringify({
      "canton:CC": { pyth: "0x" + "a".repeat(64) },
      "canton:bad": { pyth: "nope" },
      "elsewhere:x": { fixed: "1" },
    }),
  );
  assert.deepEqual(merged["canton:CC"], { pyth: "0x" + "a".repeat(64) });
  assert.equal(merged["canton:bad"], undefined);
  assert.equal(merged["elsewhere:x"], undefined);
  assert.equal(priceSources("{not json"), DEFAULT_PRICE_SOURCES);
});

test("the server prices fixed assets and asks Hermes once for feeds", async () => {
  const { usdPrices } = await import("../lib/prices/server.ts");
  const urls = [];
  const transport = async (url, init) => {
    urls.push(String(url));
    assert.equal(init.headers.authorization, "Bearer k");
    return new Response(
      JSON.stringify({
        parsed: [
          {
            id: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
            price: { price: "14250000000", expo: -8, publish_time: 1000 },
          },
        ],
      }),
    );
  };
  const result = await usdPrices({ PYTH_API_KEY: "k" }, transport, 1010);
  assert.equal(urls.length, 1);
  assert.equal(
    result.prices["solana:So11111111111111111111111111111111111111112"].usd,
    "142.5",
  );
  assert.equal(
    result.prices["solana:FUU2RPtv519UtUD2apwBRUM8BT2x2Kew71AxRRLMCAbd"].usd,
    "1",
  );
  // BTC had no fresh price in the response.
  assert.deepEqual(result.unavailable, [
    "solana:FggaZG7eJ5tpr2vmpNMbMCHkWkcw9n2Nhmf54g3wQwGk",
  ]);
  const down = await usdPrices(
    {},
    async () => new Response("", { status: 503 }),
    1010,
  );
  assert.equal(down.unavailable.length, 2);
  assert.equal(down.prices["canton:test-USD"].usd, "1");
  // Without a key nothing is requested and Pyth assets are unpriced.
  let called = false;
  const keyless = await usdPrices(
    {},
    async () => ((called = true), new Response("{}")),
    1010,
  );
  assert.equal(called, false);
  assert.equal(keyless.unavailable.length, 2);
});
