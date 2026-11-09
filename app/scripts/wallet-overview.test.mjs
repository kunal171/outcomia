// Read-only verification of real account decoding and portfolio calculations.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = fileURLToPath(new URL("../..", import.meta.url));
const req = createRequire(path.join(root, "app/package.json"));
const ts = req("typescript");
const { PublicKey, Connection } = req("@solana/web3.js");
const { Program, BN } = req("@anchor-lang/core");
const bs58 = req("bs58");
const idl = require(path.join(root, "app/idl/outcomia.json"));
const programId = new PublicKey(idl.address);
const cache = new Map();
function load(file) {
  const filename = path.resolve(root, "app/lib", file);
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = { exports: {} };
  cache.set(filename, mod);
  const source = readFileSync(filename, "utf8");
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText,
    {
      module: mod,
      exports: mod.exports,
      Buffer,
      TextEncoder,
      TextDecoder,
      URL,
      Response,
      Headers,
      AbortController,
      setTimeout,
      clearTimeout,
      process: { env: { NEXT_PUBLIC_SHARED_BALANCES_ENABLED: "true" } },
      require: (name) => {
        if (name === "./solana") return { PROGRAM_ID: programId };
        if (name.startsWith(".")) {
          const target = path.resolve(path.dirname(filename), name);
          return target.endsWith(".json")
            ? require(target)
            : load(target + ".ts");
        }
        return req(name);
      },
    },
  );
  return mod.exports;
}
const { loadWalletOverview, walletAssetRows } = load("wallet-overview.ts");
const { readableAmount } = load("market-display.ts");
const key = (n) => new PublicKey(new Uint8Array(32).fill(n));
const bn = (n) => new BN(String(n));
const derive = (seed, ...parts) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], programId)[0];
const owner = key(9),
  other = key(10),
  base = key(20),
  quote = key(21),
  base2 = key(22),
  extraListed = key(23),
  unrelated = key(24);
const market = derive("market", base.toBuffer(), quote.toBuffer());
const market2 = derive("market", base2.toBuffer(), quote.toBuffer());
const listedMarket = derive("market", extraListed.toBuffer(), quote.toBuffer());
const pred = derive("prediction_market", Buffer.alloc(32, 7));
const metadata = (address) => derive("market_metadata", address.toBuffer());
const records = new Map();
const encoder = new Program(idl, {
  connection: new Connection("http://127.0.0.1:8899"),
});
async function put(address, name, data) {
  records.set(address.toBase58(), {
    executable: false,
    owner: programId,
    lamports: 10000,
    rentEpoch: 0,
    data: await encoder.coder.accounts.encode(name, data),
  });
}
let tokenSequence = 30;
const token = (mint, amount, decimals, state = "initialized") => ({
  pubkey: key(++tokenSequence),
  account: {
    owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    data: {
      program: "spl-token",
      parsed: {
        type: "account",
        info: {
          owner: owner.toBase58(),
          mint: mint.toBase58(),
          state,
          tokenAmount: { amount, decimals, uiAmount: 0 },
        },
      },
      space: 165,
    },
    executable: false,
    lamports: 1000,
  },
});
let failTokens = false,
  failSpot = false,
  failCatalog = false,
  missingMarket = false,
  unsafeSol = false,
  wrongOwner = false;
const filtersSeen = [];
const connection = {
  commitment: "confirmed",
  getBalance: async () =>
    unsafeSol ? Number.MAX_SAFE_INTEGER + 1 : 2500000000,
  getParsedTokenAccountsByOwner: async () => {
    if (failTokens) throw Error("Token RPC unavailable");
    return {
      context: { slot: 1 },
      value: [
        token(base, "9007199254740993", 8),
        token(quote, "10000000", 6),
        token(quote, "20000000", 6, "frozen"),
        token(extraListed, "5000000", 6),
        token(unrelated, "18446744073709551615", 9),
      ],
    };
  },
  getProgramAccounts: async (_program, config) => {
    filtersSeen.push(config.filters);
    const disc = config.filters.find((f) => f.memcmp?.offset === 0)?.memcmp;
    const rawName = idl.accounts.find((a) =>
      Buffer.from(a.discriminator).equals(Buffer.from(bs58.decode(disc.bytes))),
    )?.name;
    const name = rawName?.[0].toLowerCase() + rawName?.slice(1);
    if (failSpot && name === "traderBalance")
      throw Error("Ledger RPC unavailable");
    if (failCatalog && name === "predictionMarket")
      throw Error("Listing RPC unavailable");
    return [...records]
      .filter(([address, info]) =>
        config.filters.every((f) => {
          if (f.dataSize !== undefined) return info.data.length === f.dataSize;
          const raw = Buffer.from(bs58.decode(f.memcmp.bytes));
          return info.data
            .subarray(f.memcmp.offset, f.memcmp.offset + raw.length)
            .equals(raw);
        }),
      )
      .map(([pubkey, account]) => ({
        pubkey: new PublicKey(pubkey),
        account:
          wrongOwner && name === "traderBalance"
            ? {
                ...account,
                data: Buffer.concat([
                  account.data.subarray(0, 40),
                  other.toBuffer(),
                  account.data.subarray(72),
                ]),
              }
            : account,
      }));
  },
  getMultipleAccountsInfo: async (keys) => {
    assert.ok(keys.length <= 100);
    return keys.map((k) =>
      missingMarket && k.equals(market)
        ? null
        : (records.get(k.toBase58()) ?? null),
    );
  },
};
(async () => {
  const spotTerms = (b, bd = 8) => ({
    authority: owner,
    baseMint: b,
    quoteMint: quote,
    status: { active: {} },
    nextOrderId: bn(1),
    baseDecimals: bd,
    quoteDecimals: 6,
    priceTickSize: bn(10000),
    quantityLotSize: bn(1000),
    bestBid: null,
    bestAsk: null,
    openOrderCount: bn(0),
    bump: 255,
  });
  await put(market, "market", spotTerms(base));
  await put(market2, "market", spotTerms(base2));
  await put(listedMarket, "market", spotTerms(extraListed, 6));
  for (const [address, symbol] of [
    [market, "tSOL"],
    [market2, "SAME"],
    [listedMarket, "LAUNCH"],
  ])
    await put(metadata(address), "marketMetadata", {
      market: address,
      baseSymbol: symbol,
      quoteSymbol: "tUSDC",
      displayName: symbol + " / tUSDC",
      kind: { spot: {} },
      bump: 255,
    });
  await put(pred, "predictionMarket", {
    marketId: [...Buffer.alloc(32, 7)],
    authority: owner,
    resolver: owner,
    fallback: null,
    collateralMint: quote,
    collateralVault: key(25),
    metadata: metadata(pred),
    questionHash: [...Buffer.alloc(32, 1)],
    rulesHash: [...Buffer.alloc(32, 2)],
    rulesUri: "ar://test",
    closeTs: bn(2000000000),
    earliestResolutionTs: null,
    resolutionDelaySeconds: bn(3600),
    resolutionPhase: { primary: {} },
    status: { open: {} },
    proposal: null,
    finalOutcome: null,
    payoutPerContract: bn(1000000),
    priceTick: bn(10000),
    yesSupply: bn(10),
    noSupply: bn(10),
    backingReserve: bn(10000000),
    openOrderCount: bn(1),
    bump: 255,
  });
  await put(metadata(pred), "marketMetadata", {
    market: pred,
    baseSymbol: "YES/NO",
    quoteSymbol: "tUSDC",
    displayName: "Test prediction",
    kind: { prediction: {} },
    bump: 255,
  });
  for (const [address, balance] of [
    [
      market,
      {
        baseFree: bn(100000000),
        baseLocked: bn(50000000),
        quoteFree: bn(2000000),
        quoteLocked: bn(1000000),
      },
    ],
    [
      market2,
      {
        baseFree: bn(0),
        baseLocked: bn(0),
        quoteFree: bn(3000000),
        quoteLocked: bn(0),
      },
    ],
  ])
    await put(
      derive("trader_balance", address.toBuffer(), owner.toBuffer()),
      "traderBalance",
      { market: address, owner, ...balance, bump: 255 },
    );
  await put(
    derive("trader_balance", market.toBuffer(), other.toBuffer()),
    "traderBalance",
    {
      market,
      owner: other,
      baseFree: bn(99999999),
      baseLocked: bn(0),
      quoteFree: bn(99999999),
      quoteLocked: bn(0),
      bump: 255,
    },
  );
  await put(
    derive("prediction_position", pred.toBuffer(), owner.toBuffer()),
    "predictionPosition",
    {
      market: pred,
      owner,
      collateralFree: bn(4000000),
      collateralLocked: bn(500000),
      yesFree: bn(3),
      yesLocked: bn(2),
      noFree: bn(7),
      noLocked: bn(1),
      bump: 255,
    },
  );
  let result = await loadWalletOverview(connection, owner);
  assert.equal(result.sol.data.toString(), "2500000000");
  assert.equal(result.spot.data.length, 2);
  assert.equal(result.predictions.data.length, 1);
  assert.ok(
    filtersSeen
      .filter((f) => f.some((x) => x.memcmp?.offset === 40))
      .every(
        (f) =>
          f.find((x) => x.memcmp?.offset === 40).memcmp.bytes ===
          owner.toBase58(),
      ),
  );
  let rows = walletAssetRows(result);
  assert.equal(
    rows.some((r) => r.mint.equals(unrelated)),
    false,
    "Unrelated wallet tokens excluded",
  );
  const usd = rows.find((r) => r.mint.equals(quote));
  assert.equal(usd.wallet.toString(), "30000000");
  assert.equal(usd.frozen.toString(), "20000000");
  assert.equal(usd.accountCount, 2);
  assert.equal(usd.available.toString(), "9000000");
  assert.equal(usd.inOrders.toString(), "1500000");
  assert.equal(
    usd.available.add(usd.inOrders).toString(),
    "10500000",
    "Contracts excluded from collateral totals",
  );
  assert.equal(
    rows.find((r) => r.mint.equals(extraListed)).symbol,
    "LAUNCH",
    "Listed wallet asset appears before a deposit",
  );
  assert.equal(
    readableAmount(rows.find((r) => r.mint.equals(base)).wallet, 8),
    "90,071,992.54740993",
  );
  // Shared cash is counted once, separately from legacy cash and outcome backing.
  const sharedSnapshot = {
    ...result,
    shared: {
      error: null,
      data: [
        {
          balance: {
            owner,
            mint: quote,
            free: bn(7000000),
            locked: bn(2000000),
          },
          decimals: 6,
        },
        {
          balance: { owner, mint: unrelated, free: bn(123), locked: bn(0) },
          decimals: 9,
        },
      ],
    },
  };
  const sharedRows = walletAssetRows(sharedSnapshot);
  assert.equal(
    sharedRows.find((r) => r.mint.equals(quote)).available.toString(),
    "16000000",
  );
  assert.equal(
    sharedRows.find((r) => r.mint.equals(quote)).inOrders.toString(),
    "3500000",
  );
  assert.ok(
    sharedRows.some((r) => r.mint.equals(unrelated)),
    "Delisted shared deposits stay recoverable",
  );
  assert.equal(
    walletAssetRows({
      ...result,
      shared: { data: null, error: "RPC unavailable" },
    }).find((r) => r.mint.equals(quote)).available,
    null,
  );
  // The real shared loader validates owner-at-offset-8 and actual SPL mint precision.
  const sharedAddress = derive(
    "asset_balance",
    owner.toBuffer(),
    quote.toBuffer(),
  );
  const { MintLayout, TOKEN_PROGRAM_ID } = req("@solana/spl-token");
  const mintBytes = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 100000000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    mintBytes,
  );
  records.set(quote.toBase58(), {
    data: mintBytes,
    owner: TOKEN_PROGRAM_ID,
    lamports: 10000,
    executable: false,
    rentEpoch: 0,
  });
  await put(sharedAddress, "assetBalance", {
    owner,
    mint: quote,
    free: bn(7000000),
    locked: bn(2000000),
    bump: 255,
  });
  const loadedShared = await loadWalletOverview(connection, owner);
  assert.equal(loadedShared.shared.data[0].decimals, 6);
  assert.equal(
    walletAssetRows(loadedShared)
      .find((r) => r.mint.equals(quote))
      .available.toString(),
    "16000000",
  );
  assert.ok(
    filtersSeen.some((filters) =>
      filters.some(
        (f) => f.memcmp?.offset === 8 && f.memcmp.bytes === owner.toBase58(),
      ),
    ),
  );
  records.delete(sharedAddress.toBase58());
  records.delete(quote.toBase58());
  // Existing deposits remain discoverable with zero wallet token accounts.
  const saved = connection.getParsedTokenAccountsByOwner;
  connection.getParsedTokenAccountsByOwner = async () => ({
    context: { slot: 1 },
    value: [],
  });
  result = await loadWalletOverview(connection, owner);
  rows = walletAssetRows(result);
  assert.equal(rows.find((r) => r.mint.equals(quote)).wallet.toString(), "0");
  assert.equal(
    rows.find((r) => r.mint.equals(quote)).available.toString(),
    "9000000",
  );
  connection.getParsedTokenAccountsByOwner = saved;
  failTokens = true;
  result = await loadWalletOverview(connection, owner);
  assert.ok(result.tokens.error);
  assert.equal(
    walletAssetRows(result).find((r) => r.mint.equals(quote)).wallet,
    null,
  );
  assert.equal(result.spot.data.length, 2);
  failTokens = false;
  missingMarket = true;
  result = await loadWalletOverview(connection, owner);
  assert.equal(
    result.spot.data.find((r) => r.balance.market.equals(market)).market,
    null,
  );
  assert.equal(
    walletAssetRows(result).find((r) => r.mint.equals(quote)).available,
    null,
  );
  missingMarket = false;
  failSpot = true;
  result = await loadWalletOverview(connection, owner);
  assert.ok(result.spot.error);
  assert.equal(
    walletAssetRows(result).find((r) => r.mint.equals(quote)).available,
    null,
  );
  failSpot = false;
  failCatalog = true;
  result = await loadWalletOverview(connection, owner);
  assert.ok(result.catalog.error);
  rows = walletAssetRows(result);
  assert.ok(rows.some((r) => r.mint.equals(quote)));
  assert.equal(
    rows.some((r) => r.mint.equals(extraListed)),
    false,
    "Unknown listing not guessed",
  );
  failCatalog = false;
  unsafeSol = true;
  result = await loadWalletOverview(connection, owner);
  assert.ok(result.sol.error);
  assert.equal(result.sol.data, null);
  assert.ok(result.tokens.data);
  unsafeSol = false;
  wrongOwner = true;
  result = await loadWalletOverview(connection, owner);
  assert.ok(result.spot.error);
  wrongOwner = false;
  console.log(
    "Passed: owner offset/PDA binding, non-ATA aggregation, frozen amounts, exact large integers, mint grouping, Outcomia listing filter, wallet-only listed assets, deposited-only assets, prediction contract separation and independent failure paths.",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
