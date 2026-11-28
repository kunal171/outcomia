/** Club security deposits (club rules milestone 2a): rules, valuation, the
 * Pyth SOL/USD price and instruction builders.
 *
 * Money is exact: USD amounts use 6 decimals and every calculation is in
 * bigint, mirroring the program's rounding (docs/clubs.md, Security deposit).
 * SOL is valued with Pyth's shared SOL/USD price account. When it is older
 * than the program accepts, the app waits for the next update instead of
 * posting a price itself. */
import { BN, type Program } from "@anchor-lang/core";
import {
  PublicKey,
  SystemProgram,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import { PROGRAM_ID } from "./solana";
import { TOKEN_PROGRAM_ID } from "./outcomia";

/** Pyth SOL/USD feed id (the same on devnet and mainnet). */
export const SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
/** Program that owns verified Pyth price accounts. */
export const PYTH_RECEIVER_ID = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);
/** Program whose shard-0 accounts Pyth keeps updated for each feed. */
export const PYTH_PUSH_ORACLE_ID = new PublicKey(
  "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT",
);
export const USD_DECIMALS = 6;
const USD = BigInt(10) ** BigInt(USD_DECIMALS);
const LAMPORTS_PER_SOL = BigInt(10) ** BigInt(9);

/** Values the super-admin sets; the program stores them in ClubRulesConfig. */
export interface ClubDepositRules {
  privateMinDepositUsd: BN;
  publicMinDepositUsd: BN;
  solBufferBps: number;
  solUsdFeedId: number[];
  maxPriceAgeSeconds: number;
  maxPriceConfBps: number;
}
/** The deposit fields of ClubRulesConfig. A default mint means "not set". */
export interface ClubDepositRulesAccount extends ClubDepositRules {
  depositMint: PublicKey;
  depositMintDecimals: number;
}
/** The deposit fields of a Club account. */
export interface ClubDepositAccount {
  depositAsset?: { none?: object; usdc?: object; sol?: object };
  depositAmount?: BN;
  liveMarkets?: number;
  liveMarketsReady?: boolean;
  kind?: { private?: object; public?: object };
}
export type DepositAsset = "none" | "usdc" | "sol";
export const depositAsset = (club: ClubDepositAccount): DepositAsset =>
  club.depositAsset?.usdc ? "usdc" : club.depositAsset?.sol ? "sol" : "none";
export const depositsConfigured = (
  rules: Partial<ClubDepositRulesAccount> | null | undefined,
): rules is ClubDepositRulesAccount =>
  !!rules?.depositMint && !rules.depositMint.equals(PublicKey.default);

/** Minimum deposit value for a club type, in USD with 6 decimals. */
export const minimumDepositUsd = (
  rules: ClubDepositRulesAccount,
  kind: "public" | "private",
) =>
  BigInt(
    (kind === "public"
      ? rules.publicMinDepositUsd
      : rules.privateMinDepositUsd
    ).toString(),
  );

/** A Pyth price: `price * 10^exponent` USD, published at `publishTime`. */
export interface PythPrice {
  feedId: string;
  fullyVerified: boolean;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: number;
}

/** Address of Pyth's shared price account for a feed. */
export function pythPriceAccount(feedIdHex: string = SOL_USD_FEED_ID, shard = 0) {
  const shardBytes = Buffer.alloc(2);
  shardBytes.writeUInt16LE(shard);
  return PublicKey.findProgramAddressSync(
    [shardBytes, Buffer.from(feedIdHex, "hex")],
    PYTH_PUSH_ORACLE_ID,
  )[0];
}

/** Decodes a Pyth `PriceUpdateV2` account (Anchor layout). */
export function decodePriceUpdate(data: Uint8Array): PythPrice {
  const bytes = Buffer.from(data);
  let offset = 8 + 32; // discriminator, write authority
  const level = bytes[offset];
  if (level !== 0 && level !== 1) throw new Error("Unknown Pyth verification level");
  offset += level === 0 ? 2 : 1; // Partial { num_signatures } or Full
  const feedId = bytes.subarray(offset, offset + 32).toString("hex");
  offset += 32;
  const price = bytes.readBigInt64LE(offset);
  const conf = bytes.readBigUInt64LE(offset + 8);
  const exponent = bytes.readInt32LE(offset + 16);
  const publishTime = Number(bytes.readBigInt64LE(offset + 20));
  return { feedId, fullyVerified: level === 1, price, conf, exponent, publishTime };
}

/** Reads the shared SOL/USD price account, or null when it does not exist. */
export async function readSolUsdPrice(
  connection: Connection,
  feedIdHex: string = SOL_USD_FEED_ID,
) {
  const address = pythPriceAccount(feedIdHex);
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account || !account.owner.equals(PYTH_RECEIVER_ID)) return null;
  return { address, price: decodePriceUpdate(account.data) };
}

/** Why a price cannot be used for a deposit or a market check. */
export function priceIssue(
  price: PythPrice,
  rules: Pick<ClubDepositRules, "solUsdFeedId" | "maxPriceAgeSeconds" | "maxPriceConfBps">,
  nowSeconds: number,
  marginSeconds = 0,
): string | null {
  if (price.feedId !== Buffer.from(rules.solUsdFeedId).toString("hex"))
    return "The SOL/USD price account is for another feed.";
  if (!price.fullyVerified || price.price <= BigInt(0))
    return "The SOL/USD price is not usable.";
  if (price.conf * BigInt(10_000) > price.price * BigInt(rules.maxPriceConfBps))
    return "The SOL/USD price is too uncertain right now. Try again shortly.";
  if (price.publishTime + rules.maxPriceAgeSeconds - marginSeconds < nowSeconds)
    return "SOL price is updating. Try again in a few seconds.";
  return null;
}

/** Waits until the shared SOL/USD price is fresh enough to send, leaving
 * `marginSeconds` for the transaction to land. Throws if it stays stale. */
export async function freshSolUsdPrice(
  connection: Connection,
  rules: ClubDepositRules,
  {
    marginSeconds = 15,
    waitMs = 20_000,
    pollMs = 2_000,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = {},
) {
  const feed = Buffer.from(rules.solUsdFeedId).toString("hex");
  const deadline = now() + waitMs;
  for (;;) {
    const read = await readSolUsdPrice(connection, feed);
    if (!read) throw new Error("The SOL/USD price account was not found.");
    const issue = priceIssue(read.price, rules, Math.floor(now() / 1000), marginSeconds);
    if (!issue) return read;
    // Only staleness is worth waiting for; Pyth publishes every few seconds.
    if (!issue.startsWith("SOL price is updating") || now() >= deadline)
      throw new Error(issue);
    await sleep(pollMs);
  }
}

/** Token base units for a USD amount (6 decimals), rounded up. */
export function usdToTokenUnits(usd: bigint, decimals: number) {
  return decimals >= USD_DECIMALS
    ? usd * BigInt(10) ** BigInt(decimals - USD_DECIMALS)
    : (usd + BigInt(10) ** BigInt(USD_DECIMALS - decimals) - BigInt(1)) /
        BigInt(10) ** BigInt(USD_DECIMALS - decimals);
}
/** USD value (6 decimals) of a lamport amount, rounded down like the program. */
export function lamportsToUsd(lamports: bigint, price: Pick<PythPrice, "price" | "exponent">) {
  const shift = price.exponent + USD_DECIMALS - 9;
  const product = lamports * price.price;
  return shift >= 0
    ? product * BigInt(10) ** BigInt(shift)
    : product / BigInt(10) ** BigInt(-shift);
}
/** Lamports worth at least `usd` (6 decimals) at `price`, rounded up. */
export function usdToLamports(usd: bigint, price: Pick<PythPrice, "price" | "exponent">) {
  const shift = price.exponent + USD_DECIMALS - 9;
  if (shift >= 0) {
    const unit = price.price * BigInt(10) ** BigInt(shift);
    return (usd + unit - BigInt(1)) / unit;
  }
  const numerator = usd * BigInt(10) ** BigInt(-shift);
  return (numerator + price.price - BigInt(1)) / price.price;
}

/** What a club still needs to pay to reach its payment minimum, in the
 * asset's base units. SOL includes the buffer at `price`. */
export function depositShortfall(
  rules: ClubDepositRulesAccount,
  kind: "public" | "private",
  asset: Exclude<DepositAsset, "none">,
  current: bigint,
  price?: Pick<PythPrice, "price" | "exponent"> | null,
) {
  const minimum = minimumDepositUsd(rules, kind);
  if (asset === "usdc") {
    const target = usdToTokenUnits(minimum, rules.depositMintDecimals);
    return target > current ? target - current : BigInt(0);
  }
  if (!price) throw new Error("A SOL/USD price is required.");
  const targetUsd = (minimum * BigInt(rules.solBufferBps) + BigInt(9_999)) / BigInt(10_000);
  const target = usdToLamports(targetUsd, price);
  return target > current ? target - current : BigInt(0);
}

export interface DepositStatus {
  asset: DepositAsset;
  /** Balance in the asset's base units. */
  amount: bigint;
  /** USD value (6 decimals); null for SOL without a price. */
  valueUsd: bigint | null;
  minimumUsd: bigint;
  /** Whether new markets may be created; null when it cannot be known. */
  funded: boolean | null;
}
/** A club's deposit against its dollar minimum, as the program checks it. */
export function depositStatus(
  club: ClubDepositAccount,
  rules: ClubDepositRulesAccount,
  price?: Pick<PythPrice, "price" | "exponent"> | null,
): DepositStatus {
  const kind = club.kind?.public ? "public" : "private";
  const asset = depositAsset(club);
  const amount = BigInt(club.depositAmount?.toString() ?? "0");
  const minimumUsd = minimumDepositUsd(rules, kind);
  if (asset === "none")
    return { asset, amount, valueUsd: BigInt(0), minimumUsd, funded: false };
  if (asset === "usdc") {
    const valueUsd =
      (amount * USD) / BigInt(10) ** BigInt(rules.depositMintDecimals);
    return {
      asset,
      amount,
      valueUsd,
      minimumUsd,
      funded: amount >= usdToTokenUnits(minimumUsd, rules.depositMintDecimals),
    };
  }
  if (!price) return { asset, amount, valueUsd: null, minimumUsd, funded: null };
  const valueUsd = lamportsToUsd(amount, price);
  return { asset, amount, valueUsd, minimumUsd, funded: valueUsd >= minimumUsd };
}

/** Formats a 6-decimal USD amount as dollars and cents, rounded down. */
export const formatUsd = (usd: bigint) => {
  const cents = usd / BigInt(10_000);
  return `$${(cents / BigInt(100)).toLocaleString("en-US")}.${String(cents % BigInt(100)).padStart(2, "0")}`;
};
/** Formats lamports as SOL with up to 4 decimals, rounded up for amounts due. */
export const formatSol = (lamports: bigint, roundUp = false) => {
  const step = LAMPORTS_PER_SOL / BigInt(10_000);
  const units = roundUp ? (lamports + step - BigInt(1)) / step : lamports / step;
  const whole = units / BigInt(10_000);
  const fraction = String(units % BigInt(10_000)).padStart(4, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} SOL`;
};

/** Parses a decimal string into base units, or null when invalid. */
export function parseUnits(text: string, decimals: number) {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) return null;
  return (
    BigInt(whole) * BigInt(10) ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}

const address = (seed: string, ...parts: Uint8Array[]) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...parts.map((p) => Buffer.from(p))],
    PROGRAM_ID,
  )[0];
const clubRulesPda = () => address("club_rules_config");
export const clubDepositVaultPda = (club: PublicKey) =>
  address("club_deposit_vault", club.toBytes());

export const setClubDepositRulesInstruction = (
  p: Program,
  superAdmin: PublicKey,
  depositMint: PublicKey,
  rules: ClubDepositRules,
): Promise<TransactionInstruction> =>
  p.methods
    .setClubDepositRules(rules)
    .accountsPartial({ superAdmin, clubRules: clubRulesPda(), depositMint })
    .instruction();
export const depositClubUsdcInstruction = (
  p: Program,
  owner: PublicKey,
  club: PublicKey,
  depositMint: PublicKey,
  ownerToken: PublicKey,
  amount: bigint,
): Promise<TransactionInstruction> =>
  p.methods
    .depositClubUsdc(new BN(amount.toString()))
    .accountsPartial({
      owner,
      club,
      clubRules: clubRulesPda(),
      depositMint,
      ownerToken,
      depositVault: clubDepositVaultPda(club),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
export const depositClubSolInstruction = (
  p: Program,
  owner: PublicKey,
  club: PublicKey,
  priceUpdate: PublicKey,
  lamports: bigint,
): Promise<TransactionInstruction> =>
  p.methods
    .depositClubSol(new BN(lamports.toString()))
    .accountsPartial({
      owner,
      club,
      clubRules: clubRulesPda(),
      priceUpdate,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
/** One-time count of a pre-counter club's existing markets (super-admin). */
export const setClubLiveMarketsInstruction = (
  p: Program,
  superAdmin: PublicKey,
  club: PublicKey,
  count: number,
): Promise<TransactionInstruction> =>
  p.methods
    .setClubLiveMarkets(count)
    .accountsPartial({ superAdmin, club })
    .instruction();

/** Checks that a club may create or open markets right now, as the program
 * will, and returns the price account to pass (null for USDC deposits).
 * Call it before any paid step (such as the rules upload) and again just
 * before sending, so the SOL price is fresh when the transaction lands. */
export async function clubMarketPriceAccount(
  connection: Connection,
  club: ClubDepositAccount,
  rules: Partial<ClubDepositRulesAccount> | null | undefined,
): Promise<PublicKey | null> {
  if (!depositsConfigured(rules))
    throw new Error(
      "Club deposits are not set up yet, so club markets cannot be created.",
    );
  if (club.liveMarketsReady === false)
    throw new Error(
      "This club's market count must be recorded by the platform admin before it creates markets.",
    );
  const asset = depositAsset(club);
  if (asset === "none")
    throw new Error(
      "This club needs a security deposit before it can create markets. The owner can pay it on the club page.",
    );
  let priceAccount: PublicKey | null = null;
  let status: DepositStatus;
  if (asset === "sol") {
    const read = await freshSolUsdPrice(connection, rules);
    priceAccount = read.address;
    status = depositStatus(club, rules, read.price);
  } else status = depositStatus(club, rules);
  if (!status.funded)
    throw new Error(
      "This club's deposit is below the minimum. The owner can top it up on the club page.",
    );
  return priceAccount;
}
