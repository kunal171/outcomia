// Club deposits: exact USD/SOL math, Pyth price decoding and freshness, and
// instruction encodings, without a wallet or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const require = createRequire(import.meta.url),
  { BN, Program } = require("@anchor-lang/core"),
  { PublicKey, Connection } = require("@solana/web3.js");
const idl = JSON.parse(
    readFileSync(new URL("../idl/outcomia.json", import.meta.url), "utf8"),
  ),
  programId = new PublicKey(idl.address),
  p = new Program(idl, { connection: new Connection("http://127.0.0.1:8899") });
const derive = (seed, ...parts) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], programId)[0];
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
function load(file, modules) {
  const mod = { exports: {} };
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL(`../lib/${file}`, import.meta.url), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      },
    ).outputText,
    {
      module: mod,
      exports: mod.exports,
      Buffer,
      BigInt,
      Date,
      setTimeout,
      require: (name) => modules[name] ?? require(name),
    },
  );
  return mod.exports;
}
const d = load("club-deposits.ts", {
  "./solana": { PROGRAM_ID: programId },
  "./outcomia": { TOKEN_PROGRAM_ID: TOKEN },
});
const key = (n) => new PublicKey(Buffer.alloc(32, n));
const name = (i) => p.coder.instruction.decode(i.data).name;
function account(i, n) {
  const ix = idl.instructions.find(
    (x) => x.name === name(i).replace(/[A-Z]/g, (ch) => "_" + ch.toLowerCase()),
  );
  return i.keys[ix.accounts.findIndex((x) => x.name === n)].pubkey;
}
const FEED = Array.from(Buffer.from(d.SOL_USD_FEED_ID, "hex"));
const rules = {
  depositMint: key(9),
  depositMintDecimals: 6,
  privateMinDepositUsd: new BN(100_000_000),
  publicMinDepositUsd: new BN(200_000_000),
  solBufferBps: 12_000,
  solUsdFeedId: FEED,
  maxPriceAgeSeconds: 60,
  maxPriceConfBps: 100,
};
/** $150.00000000 at exponent -8, as the program's tests use. */
const P150 = { price: 15_000_000_000n, exponent: -8 };

/** A PriceUpdateV2 account body, as the Pyth receiver writes it. */
function priceAccount({
  level = "full",
  feed = d.SOL_USD_FEED_ID,
  price = 15_000_000_000n,
  conf = 1_000_000n,
  exponent = -8,
  publishTime = 1_000,
} = {}) {
  const parts = [Buffer.alloc(8, 1), Buffer.alloc(32, 2)];
  parts.push(level === "full" ? Buffer.from([1]) : Buffer.from([0, 5]));
  parts.push(Buffer.from(feed, "hex"));
  const nums = Buffer.alloc(8 + 8 + 4 + 8 + 8 + 8 + 8 + 8);
  nums.writeBigInt64LE(price, 0);
  nums.writeBigUInt64LE(conf, 8);
  nums.writeInt32LE(exponent, 16);
  nums.writeBigInt64LE(BigInt(publishTime), 20);
  parts.push(nums);
  return Buffer.concat(parts);
}

test("USD, token and lamport conversions match the program's rounding", () => {
  assert.equal(d.usdToTokenUnits(100_000_000n, 6), 100_000_000n);
  assert.equal(d.usdToTokenUnits(100_000_000n, 9), 100_000_000_000n);
  assert.equal(d.usdToTokenUnits(100_000_001n, 2), 10_001n);
  assert.equal(d.lamportsToUsd(1_000_000_000n, P150), 150_000_000n);
  assert.equal(d.lamportsToUsd(1n, P150), 0n);
  assert.equal(d.lamportsToUsd(1_000_000_000n, { price: 15n, exponent: 1 }), 150_000_000n);
  // Rounded up, so the program's rounded-down value still reaches the target.
  const lamports = d.usdToLamports(240_000_000n, P150);
  assert.equal(lamports, 1_600_000_000n);
  assert(d.lamportsToUsd(lamports, P150) >= 240_000_000n);
  const odd = { price: 13_333_333_333n, exponent: -8 };
  const l2 = d.usdToLamports(100_000_001n, odd);
  assert(d.lamportsToUsd(l2, odd) >= 100_000_001n);
  assert(d.lamportsToUsd(l2 - 1n, odd) < 100_000_001n);
});

test("shortfalls cover the minimum (USDC) or the buffered minimum (SOL)", () => {
  assert.equal(d.depositShortfall(rules, "public", "usdc", 0n), 200_000_000n);
  assert.equal(d.depositShortfall(rules, "private", "usdc", 60_000_000n), 40_000_000n);
  assert.equal(d.depositShortfall(rules, "private", "usdc", 100_000_000n), 0n);
  // $200 x 120% = $240 = 1.6 SOL at $150, the amount the program accepts.
  assert.equal(d.depositShortfall(rules, "public", "sol", 0n, P150), 1_600_000_000n);
  assert.equal(d.depositShortfall(rules, "public", "sol", 1_000_000_000n, P150), 600_000_000n);
  assert.throws(() => d.depositShortfall(rules, "public", "sol", 0n, null));
});

test("deposit status follows the program's below-minimum rule", () => {
  const club = (asset, amount, kind = "private") => ({
    depositAsset: { [asset]: {} },
    depositAmount: new BN(amount),
    kind: { [kind]: {} },
  });
  const none = d.depositStatus(club("none", 0), rules);
  assert.equal(none.funded, false);
  assert.equal(d.depositStatus(club("usdc", 100_000_000), rules).funded, true);
  assert.equal(d.depositStatus(club("usdc", 99_999_999), rules).funded, false);
  assert.equal(d.depositStatus(club("usdc", 100_000_000, "public"), rules).funded, false);
  // SOL needs a price; 0.8 SOL is $100 at $125 and $99.20 at $124.
  assert.equal(d.depositStatus(club("sol", 800_000_000), rules).funded, null);
  const at = (price) => ({ price, exponent: -8 });
  assert.equal(d.depositStatus(club("sol", 800_000_000), rules, at(12_500_000_000n)).funded, true);
  const low = d.depositStatus(club("sol", 800_000_000), rules, at(12_400_000_000n));
  assert.equal(low.funded, false);
  assert.equal(d.formatUsd(low.valueUsd), "$99.20");
  assert(!d.depositsConfigured({ depositMint: PublicKey.default }));
  assert(d.depositsConfigured(rules));
});

test("Pyth price accounts decode and are checked like the program", () => {
  const full = d.decodePriceUpdate(priceAccount());
  assert.deepEqual(
    { ...full },
    {
      feedId: d.SOL_USD_FEED_ID,
      fullyVerified: true,
      price: 15_000_000_000n,
      conf: 1_000_000n,
      exponent: -8,
      publishTime: 1_000,
    },
  );
  const partial = d.decodePriceUpdate(priceAccount({ level: "partial", publishTime: 7 }));
  assert.equal(partial.fullyVerified, false);
  assert.equal(partial.publishTime, 7);
  assert.equal(d.priceIssue(full, rules, 1_060), null);
  assert.match(d.priceIssue(full, rules, 1_061), /updating/);
  assert.match(d.priceIssue(full, rules, 1_050, 15), /updating/);
  assert.match(d.priceIssue(partial, rules, 7), /not usable/);
  const wide = d.decodePriceUpdate(priceAccount({ conf: 151_500_000n }));
  assert.match(d.priceIssue(wide, rules, 1_000), /uncertain/);
  const other = d.decodePriceUpdate(priceAccount({ feed: "11".repeat(32) }));
  assert.match(d.priceIssue(other, rules, 1_000), /another feed/);
  // The shared account Pyth keeps updated for SOL/USD.
  assert.equal(
    d.pythPriceAccount().toBase58(),
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
  );
});

test("a stale shared price is re-read until fresh, then given up on", async () => {
  let clock = 1_100_000; // ms
  const reads = [990, 1_000, 1_090]; // publish times, in seconds
  const connection = {
    getAccountInfo: async () => ({
      owner: d.PYTH_RECEIVER_ID,
      data: priceAccount({ publishTime: reads.shift() ?? 990 }),
    }),
  };
  const opts = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  // At 1,100 s, 990 and 1,000 are too old with a 15 s margin; 1,090 passes.
  const read = await d.freshSolUsdPrice(connection, rules, opts);
  assert.equal(read.price.publishTime, 1_090);
  assert(read.address.equals(d.pythPriceAccount()));
  await assert.rejects(
    d.freshSolUsdPrice(connection, rules, { ...opts, waitMs: 5_000 }),
    /updating/,
  );
  const missing = { getAccountInfo: async () => null };
  await assert.rejects(d.freshSolUsdPrice(missing, rules, opts), /not found/);
});

test("market checks refuse unready, unpaid and underfunded clubs", async () => {
  const connection = {
    getAccountInfo: async () => ({
      owner: d.PYTH_RECEIVER_ID,
      data: priceAccount({ publishTime: Math.floor(Date.now() / 1000) }),
    }),
  };
  const club = (asset, amount, ready = true) => ({
    depositAsset: { [asset]: {} },
    depositAmount: new BN(amount),
    kind: { private: {} },
    liveMarketsReady: ready,
  });
  await assert.rejects(
    d.clubMarketPriceAccount(connection, club("usdc", 1), { depositMint: PublicKey.default }),
    /not set up/,
  );
  await assert.rejects(
    d.clubMarketPriceAccount(connection, club("usdc", 100_000_000, false), rules),
    /market count/,
  );
  await assert.rejects(d.clubMarketPriceAccount(connection, club("none", 0), rules), /needs a security deposit/);
  await assert.rejects(d.clubMarketPriceAccount(connection, club("usdc", 1), rules), /below the minimum/);
  assert.equal(await d.clubMarketPriceAccount(connection, club("usdc", 100_000_000), rules), null);
  const price = await d.clubMarketPriceAccount(connection, club("sol", 800_000_000), rules);
  assert(price.equals(d.pythPriceAccount()));
});

test("deposit instructions name the right accounts", async () => {
  const owner = key(1),
    club = key(2),
    mint = key(3),
    token = key(4),
    price = key(5);
  const usdc = await d.depositClubUsdcInstruction(p, owner, club, mint, token, 200_000_000n);
  assert.equal(name(usdc), "depositClubUsdc");
  assert.equal(p.coder.instruction.decode(usdc.data).data.amount.toString(), "200000000");
  assert(account(usdc, "deposit_vault").equals(derive("club_deposit_vault", club.toBuffer())));
  assert(account(usdc, "deposit_vault").equals(d.clubDepositVaultPda(club)));
  assert(account(usdc, "club_rules").equals(derive("club_rules_config")));
  assert(account(usdc, "owner_token").equals(token));
  const sol = await d.depositClubSolInstruction(p, owner, club, price, 1_600_000_000n);
  assert.equal(name(sol), "depositClubSol");
  assert(account(sol, "price_update").equals(price));
  const set = await d.setClubDepositRulesInstruction(p, owner, mint, {
    privateMinDepositUsd: new BN(100_000_000),
    publicMinDepositUsd: new BN(200_000_000),
    solBufferBps: 12_000,
    solUsdFeedId: FEED,
    maxPriceAgeSeconds: 60,
    maxPriceConfBps: 100,
  });
  assert.equal(name(set), "setClubDepositRules");
  assert(account(set, "deposit_mint").equals(mint));
  assert(account(set, "protocol_config").equals(derive("protocol_config")));
  const count = await d.setClubLiveMarketsInstruction(p, owner, club, 3);
  assert.equal(p.coder.instruction.decode(count.data).data.count, 3);
});

test("amounts parse and format exactly", () => {
  assert.equal(d.parseUnits("1.5", 9), 1_500_000_000n);
  assert.equal(d.parseUnits("200", 6), 200_000_000n);
  assert.equal(d.parseUnits("0.1234567", 6), null);
  assert.equal(d.parseUnits("abc", 6), null);
  assert.equal(d.formatUsd(240_000_000n), "$240.00");
  assert.equal(d.formatUsd(1_234_567_890n), "$1,234.56");
  assert.equal(d.formatSol(1_600_000_000n), "1.6 SOL");
  assert.equal(d.formatSol(1_600_010_000n, true), "1.6001 SOL");
});
