/** Read-only portfolio discovery. Amounts stay in integer atoms; markets remain separate. */
import { BN, type Program } from "@anchor-lang/core";
import { Connection, PublicKey, type ParsedAccountData } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  deriveMarketMetadataPda,
  deriveMarketPda,
  deriveTraderBalancePda,
  getTidebookAccounts,
  getTidebookReadProgram,
  type MarketAccount,
  type MarketMetadataAccount,
  type TraderBalanceAccount,
} from "./tidebook";
import {
  derivePredictionMarketPda,
  derivePredictionPositionPda,
  type PredictionMarketAccount,
  type PredictionPositionAccount,
} from "./prediction";
import { knownTokenSymbol } from "./market-display";
import { rpcErrorMessage } from "./rpc-transport";

export interface ReadResult<T> {
  data: T | null;
  error: string | null;
}
export interface TokenHolding {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  amount: BN;
  frozen: BN;
  accountCount: number;
}
interface MarketContext<T> {
  market: T | null;
  metadata: MarketMetadataAccount | null;
  issue: string | null;
}
export interface SpotHolding extends MarketContext<MarketAccount> {
  address: PublicKey;
  balance: TraderBalanceAccount;
}
export interface PredictionHolding extends MarketContext<PredictionMarketAccount> {
  address: PublicKey;
  balance: PredictionPositionAccount;
}
export interface ListedAsset {
  mint: PublicKey;
  decimals: number;
  symbol?: string;
}
export interface WalletOverview {
  owner: PublicKey;
  readAt: number;
  sol: ReadResult<BN>;
  tokens: ReadResult<TokenHolding[]>;
  catalog: ReadResult<ListedAsset[]>;
  spot: ReadResult<SpotHolding[]>;
  predictions: ReadResult<PredictionHolding[]>;
}

async function read<T>(action: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { data: await action(), error: null };
  } catch (cause) {
    return {
      data: null,
      error: rpcErrorMessage(cause, "Balances could not be loaded"),
    };
  }
}
function decimalsValid(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}
function validateAmounts(values: BN[]) {
  if (values.some((value) => value.isNeg() || value.bitLength() > 64))
    throw new Error("Invalid balance account amounts");
}

/** Aggregate every owned account, including non-ATAs, without Number/uiAmount rounding. */
async function readTokens(
  connection: Connection,
  owner: PublicKey,
  tokenProgram: PublicKey,
): Promise<TokenHolding[]> {
  const response = await connection.getParsedTokenAccountsByOwner(
    owner,
    { programId: tokenProgram },
    "confirmed",
  );
  const holdings = new Map<string, TokenHolding>();
  for (const { account } of response.value) {
    if (!account.owner.equals(tokenProgram))
      throw new Error("Unexpected token account program");
    const data = account.data as ParsedAccountData;
    const info = data.parsed?.info;
    if (
      data.parsed?.type !== "account" ||
      info?.owner !== owner.toBase58() ||
      typeof info.mint !== "string" ||
      !["initialized", "frozen"].includes(info.state)
    )
      throw new Error("Invalid owned token account");
    const mint = new PublicKey(info.mint);
    const { amount, decimals } = info.tokenAmount ?? {};
    if (
      typeof amount !== "string" ||
      !/^\d{1,20}$/.test(amount) ||
      !decimalsValid(decimals)
    )
      throw new Error("Invalid token amount or precision");
    const atoms = new BN(amount);
    validateAmounts([atoms]);
    const existing = holdings.get(info.mint);
    if (existing && existing.decimals !== decimals)
      throw new Error("Conflicting mint precision");
    const row = existing ?? {
      mint,
      tokenProgram,
      decimals,
      amount: new BN(0),
      frozen: new BN(0),
      accountCount: 0,
    };
    row.amount = row.amount.add(atoms);
    if (info.state === "frozen") row.frozen = row.frozen.add(atoms);
    row.accountCount++;
    holdings.set(info.mint, row);
  }
  return [...holdings.values()];
}

/** Read only referenced markets, in batches of at most 100 accounts including labels.
 * Missing/incompatible markets retain their ledger row with unavailable units.
 * Optional labels never determine ownership or make a failed balance read zero.
 */
async function readContexts<T>(
  connection: Connection,
  program: Program,
  keys: PublicKey[],
  name: "market" | "predictionMarket",
  valid: (market: T, address: PublicKey) => boolean,
) {
  const unique = [
    ...new Map(keys.map((key) => [key.toBase58(), key])).values(),
  ];
  const result = new Map<string, MarketContext<T>>();
  for (let offset = 0; offset < unique.length; offset += 50) {
    const batch = unique.slice(offset, offset + 50);
    try {
      const infos = await connection.getMultipleAccountsInfo(
        [...batch, ...batch.map(deriveMarketMetadataPda)],
        "confirmed",
      );
      batch.forEach((address, index) => {
        const fallback: MarketContext<T> = {
          market: null,
          metadata: null,
          issue:
            "Market details or token units are unavailable. Refresh before managing funds.",
        };
        result.set(address.toBase58(), fallback);
        const info = infos[index];
        if (!info?.owner.equals(program.programId)) return;
        try {
          const market = program.coder.accounts.decode<T>(name, info.data);
          if (!valid(market, address)) return;
          let metadata: MarketMetadataAccount | null = null;
          const labelInfo = infos[index + batch.length];
          if (labelInfo?.owner.equals(program.programId)) {
            try {
              const label =
                program.coder.accounts.decode<MarketMetadataAccount>(
                  "marketMetadata",
                  labelInfo.data,
                );
              if (label.market.equals(address)) metadata = label;
            } catch {
              /* Older or absent metadata does not change the token amounts. */
            }
          }
          result.set(address.toBase58(), { market, metadata, issue: null });
        } catch {
          /* Retain the ledger without guessing the precision of an old layout. */
        }
      });
    } catch (cause) {
      for (const key of batch)
        result.set(key.toBase58(), {
          market: null,
          metadata: null,
          issue: rpcErrorMessage(cause, "Market details could not be loaded"),
        });
    }
  }
  return result;
}

async function readSpot(
  connection: Connection,
  program: Program,
  owner: PublicKey,
): Promise<SpotHolding[]> {
  // Both ledger structs store market first, then owner: discriminator 8 + market 32.
  const records = await getTidebookAccounts(program).traderBalance.all([
    { memcmp: { offset: 40, bytes: owner.toBase58() } },
  ]);
  for (const { publicKey, account } of records) {
    if (
      !account.owner.equals(owner) ||
      !publicKey.equals(deriveTraderBalancePda(account.market, owner))
    )
      throw new Error("Unexpected trader balance ownership or address");
    validateAmounts([
      account.baseFree,
      account.baseLocked,
      account.quoteFree,
      account.quoteLocked,
    ]);
  }
  const contexts = await readContexts<MarketAccount>(
    connection,
    program,
    records.map((row) => row.account.market),
    "market",
    (market, key) =>
      decimalsValid(market.baseDecimals) &&
      decimalsValid(market.quoteDecimals) &&
      !market.baseMint.equals(market.quoteMint) &&
      deriveMarketPda(market.baseMint, market.quoteMint).equals(key),
  );
  return records.map(({ publicKey, account }) => ({
    address: publicKey,
    balance: account,
    ...contexts.get(account.market.toBase58())!,
  }));
}
async function readPredictions(
  connection: Connection,
  program: Program,
  owner: PublicKey,
): Promise<PredictionHolding[]> {
  const records = await getTidebookAccounts(program).predictionPosition.all([
    { memcmp: { offset: 40, bytes: owner.toBase58() } },
  ]);
  for (const { publicKey, account } of records) {
    if (
      !account.owner.equals(owner) ||
      !publicKey.equals(derivePredictionPositionPda(account.market, owner))
    )
      throw new Error("Unexpected prediction position ownership or address");
    validateAmounts([
      account.collateralFree,
      account.collateralLocked,
      account.yesFree,
      account.yesLocked,
      account.noFree,
      account.noLocked,
    ]);
  }
  const contexts = await readContexts<PredictionMarketAccount>(
    connection,
    program,
    records.map((row) => row.account.market),
    "predictionMarket",
    (market, key) =>
      /^10*$/.test(market.payoutPerContract.toString()) &&
      derivePredictionMarketPda(new Uint8Array(market.marketId)).equals(key),
  );
  return records.map(({ publicKey, account }) => ({
    address: publicKey,
    balance: account,
    ...contexts.get(account.market.toBase58())!,
  }));
}

/** Listing checks use actual market accounts, never arbitrary wallet-token symbols.
 * Labels are optional; failed metadata reads do not invent or remove listings.
 */
async function readCatalog(program: Program): Promise<ListedAsset[]> {
  const accounts = getTidebookAccounts(program);
  const [spots, predictions, labels] = await Promise.all([
    accounts.market.all(),
    accounts.predictionMarket.all(),
    read(() => accounts.marketMetadata.all()),
  ]);
  const metadata = new Map(
    (labels.data ?? [])
      .filter((row) =>
        row.publicKey.equals(deriveMarketMetadataPda(row.account.market)),
      )
      .map((row) => [row.account.market.toBase58(), row.account]),
  );
  const assets: ListedAsset[] = [];
  for (const { publicKey, account: market } of spots) {
    if (
      !deriveMarketPda(market.baseMint, market.quoteMint).equals(publicKey) ||
      !decimalsValid(market.baseDecimals) ||
      !decimalsValid(market.quoteDecimals)
    )
      throw new Error("Invalid spot market listing");
    const label = metadata.get(publicKey.toBase58());
    assets.push(
      {
        mint: market.baseMint,
        decimals: market.baseDecimals,
        symbol: label?.baseSymbol,
      },
      {
        mint: market.quoteMint,
        decimals: market.quoteDecimals,
        symbol: label?.quoteSymbol,
      },
    );
  }
  for (const { publicKey, account: market } of predictions) {
    if (
      !derivePredictionMarketPda(new Uint8Array(market.marketId)).equals(
        publicKey,
      ) ||
      !/^10*$/.test(market.payoutPerContract.toString())
    )
      throw new Error("Invalid prediction market listing");
    assets.push({
      mint: market.collateralMint,
      decimals: market.payoutPerContract.toString().length - 1,
      symbol: metadata.get(publicKey.toBase58())?.quoteSymbol,
    });
  }
  return assets;
}

/** No signing, token transfers or automatic polling. Independent failures stay visible. */
export async function loadWalletOverview(
  connection: Connection,
  owner: PublicKey,
): Promise<WalletOverview> {
  const program = getTidebookReadProgram(connection);
  const [sol, tokens, catalog, spot, predictions] = await Promise.all([
    read(async () => {
      const lamports = await connection.getBalance(owner, "confirmed");
      if (!Number.isSafeInteger(lamports) || lamports < 0)
        throw new Error("SOL balance exceeds the safe RPC number range");
      return new BN(String(lamports));
    }),
    read(() => readTokens(connection, owner, TOKEN_PROGRAM_ID)),
    read(() => readCatalog(program)),
    read(() => readSpot(connection, program, owner)),
    read(() => readPredictions(connection, program, owner)),
  ]);
  return {
    owner,
    readAt: Date.now(),
    sol,
    tokens,
    catalog,
    spot,
    predictions,
  };
}

export interface AssetRow {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  symbol: string;
  wallet: BN | null;
  frozen: BN;
  accountCount: number;
  available: BN | null;
  inOrders: BN | null;
  precisionIssue: boolean;
  labelConflict: boolean;
}

/** Group by mint/program, never by symbol. Contract claims are NOT collateral balances.
 * If any market's units are unknown, aggregate deposits are unavailable rather
 * than presenting a partial sum as the wallet's complete Tidebook balance.
 */
export function walletAssetRows(snapshot: WalletOverview): AssetRow[] {
  const spotComplete =
    snapshot.spot.data !== null &&
    snapshot.spot.data.every((row) => row.market !== null);
  const predictionComplete =
    snapshot.predictions.data !== null &&
    snapshot.predictions.data.every((row) => row.market !== null);
  const complete = spotComplete && predictionComplete;
  const rows = new Map<string, AssetRow & { labels: Set<string> }>();
  function get(
    mint: PublicKey,
    decimals: number,
    tokenProgram = TOKEN_PROGRAM_ID,
    label?: string,
  ) {
    const key = `${tokenProgram.toBase58()}:${mint.toBase58()}`;
    let row = rows.get(key);
    if (!row) {
      const walletComplete = snapshot.tokens.data !== null;
      const depositsKnown = complete || !tokenProgram.equals(TOKEN_PROGRAM_ID);
      row = {
        mint,
        tokenProgram,
        decimals,
        symbol: "Token",
        wallet: walletComplete ? new BN(0) : null,
        frozen: new BN(0),
        accountCount: 0,
        available: depositsKnown ? new BN(0) : null,
        inOrders: depositsKnown ? new BN(0) : null,
        precisionIssue: false,
        labelConflict: false,
        labels: new Set(),
      };
      rows.set(key, row);
    }
    if (row.decimals !== decimals) row.precisionIssue = true;
    if (label?.trim()) row.labels.add(label.trim());
    return row;
  }
  const listed = new Set(
    (snapshot.catalog.data ?? []).map((asset) => asset.mint.toBase58()),
  );
  for (const item of snapshot.spot.data ?? []) {
    if (item.market) {
      listed.add(item.market.baseMint.toBase58());
      listed.add(item.market.quoteMint.toBase58());
    }
  }
  for (const item of snapshot.predictions.data ?? []) {
    if (item.market) listed.add(item.market.collateralMint.toBase58());
  }
  for (const token of snapshot.tokens.data ?? []) {
    if (!listed.has(token.mint.toBase58())) continue;
    const row = get(token.mint, token.decimals, token.tokenProgram);
    row.wallet = token.amount;
    row.frozen = token.frozen;
    row.accountCount = token.accountCount;
  }
  for (const item of snapshot.spot.data ?? []) {
    if (!item.market) continue;
    const { market, balance, metadata } = item;
    for (const [mint, decimals, free, locked, label] of [
      [
        market.baseMint,
        market.baseDecimals,
        balance.baseFree,
        balance.baseLocked,
        metadata?.baseSymbol,
      ],
      [
        market.quoteMint,
        market.quoteDecimals,
        balance.quoteFree,
        balance.quoteLocked,
        metadata?.quoteSymbol,
      ],
    ] as const) {
      const row = get(mint, decimals, TOKEN_PROGRAM_ID, label);
      if (complete) {
        row.available = row.available!.add(free);
        row.inOrders = row.inOrders!.add(locked);
      }
    }
  }
  for (const item of snapshot.predictions.data ?? []) {
    if (!item.market) continue;
    const row = get(
      item.market.collateralMint,
      item.market.payoutPerContract.toString().length - 1,
      TOKEN_PROGRAM_ID,
      item.metadata?.quoteSymbol,
    );
    if (complete) {
      row.available = row.available!.add(item.balance.collateralFree);
      row.inOrders = row.inOrders!.add(item.balance.collateralLocked);
    }
  }
  for (const listing of snapshot.catalog.data ?? []) {
    const row = rows.get(
      `${TOKEN_PROGRAM_ID.toBase58()}:${listing.mint.toBase58()}`,
    );
    if (!row) continue;
    if (row.decimals !== listing.decimals) row.precisionIssue = true;
    if (listing.symbol?.trim()) row.labels.add(listing.symbol.trim());
  }
  return [...rows.values()]
    .map(({ labels, ...row }) => ({
      ...row,
      symbol:
        labels.size === 1
          ? [...labels][0]
          : labels.size === 0
            ? (knownTokenSymbol(row.mint) ?? "Token")
            : "Token",
      labelConflict: labels.size > 1,
    }))
    .sort(
      (a, b) =>
        a.symbol.localeCompare(b.symbol) ||
        a.mint.toBase58().localeCompare(b.mint.toBase58()),
    );
}
