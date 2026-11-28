/** Outcome disputes on prediction markets (club rules milestone 3,
 * docs/clubs.md, Disputes): addresses, readers, the window
 * and ruling rules mirrored from the program, and instruction builders for
 * binary and multi-outcome markets. The program enforces every rule. */
import { BN, type Program } from "@anchor-lang/core";
import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import { PROGRAM_ID } from "./solana";
import { TOKEN_PROGRAM_ID } from "./outcomia";
import { indexedAccounts } from "./indexed-accounts";

const address = (seed: string, ...parts: Uint8Array[]) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...parts.map((p) => Buffer.from(p))],
    PROGRAM_ID,
  )[0];
export const disputeConfigPda = () => address("dispute_config");
export const marketDisputePda = (market: PublicKey) =>
  address("market_dispute", market.toBytes());
export const disputeBondPda = (market: PublicKey) =>
  address("dispute_bond", market.toBytes());
const clubMarketPda = (market: PublicKey) =>
  address("club_market", market.toBytes());
const clubMemberPda = (club: PublicKey, wallet: PublicKey) =>
  address("club_member", club.toBytes(), wallet.toBytes());
const adminRecordPda = (wallet: PublicKey) => address("admin", wallet.toBytes());

export interface DisputeConfigAccount {
  clubWindowSeconds: BN;
  regularWindowSeconds: BN;
  bondTokens: BN;
  rulingDeadlineSeconds: BN;
  treasury: PublicKey;
}
export type DisputeStateName =
  | "none"
  | "open"
  | "upheld"
  | "overturned"
  | "invalidated"
  | "expired";
export interface MarketDisputeAccount {
  market: PublicKey;
  windowSeconds: BN;
  clubMarket: boolean;
  state: Partial<Record<DisputeStateName, object>>;
  disputer: PublicKey;
  bondMint: PublicKey;
  bondAmount: BN;
  openedAt: BN;
  rulingDeadline: BN;
  ruledBy: PublicKey | null;
  clubPenaltyDue: boolean;
}
export const disputeState = (d: Pick<MarketDisputeAccount, "state">) =>
  (Object.keys(d.state)[0] ?? "none") as DisputeStateName;

interface Reader<T> {
  fetchNullable(key: PublicKey): Promise<T | null>;
  all(
    filters?: { memcmp: { offset: number; bytes: string } }[],
  ): Promise<{ publicKey: PublicKey; account: T }[]>;
}
function accounts(p: Program) {
  return indexedAccounts(p) as unknown as {
    disputeConfig: Reader<DisputeConfigAccount>;
    marketDispute: Reader<MarketDisputeAccount>;
  };
}
export const readDisputeConfig = (p: Program) =>
  accounts(p).disputeConfig.fetchNullable(disputeConfigPda()).catch(() => null);
export const readMarketDispute = (p: Program, market: PublicKey) =>
  accounts(p).marketDispute.fetchNullable(marketDisputePda(market)).catch(() => null);
/** Every dispute waiting for a ruling, for the admin queue. */
export async function readOpenDisputes(p: Program) {
  const rows = await accounts(p).marketDispute.all();
  return rows
    .filter((r) => disputeState(r.account) === "open")
    .sort((a, b) => a.account.rulingDeadline.cmp(b.account.rulingDeadline));
}

/** The proposal fields the window depends on. */
export interface ProposedMarket {
  proposal: { proposedAt: BN } | null;
  resolutionDelaySeconds: BN;
}
/** First second the proposal may be finalized: after the review delay and
 * the dispute window, as the program computes it. */
export function windowEnd(market: ProposedMarket, dispute: MarketDisputeAccount) {
  if (!market.proposal) return null;
  const at = market.proposal.proposedAt.toNumber();
  return Math.max(
    at + market.resolutionDelaySeconds.toNumber(),
    at + dispute.windowSeconds.toNumber(),
  );
}
/** Whether a holder may dispute now. */
export function canDispute(
  status: Record<string, object>,
  market: ProposedMarket,
  dispute: MarketDisputeAccount | null,
  nowSeconds: number,
) {
  if (!dispute || !("proposed" in status) || disputeState(dispute) !== "none")
    return false;
  const end = windowEnd(market, dispute);
  return end !== null && nowSeconds < end;
}
/** Why this wallet cannot rule, mirroring the program (club admins are
 * checked on chain only). */
export function rulerIssue(
  ruler: PublicKey,
  creator: PublicKey,
  resolver: PublicKey,
  fallback: { resolver: PublicKey } | null,
) {
  if (ruler.equals(creator)) return "The market's creator cannot rule on its dispute.";
  if (ruler.equals(resolver) || fallback?.resolver.equals(ruler))
    return "The market's resolvers cannot rule on its dispute.";
  return null;
}
/** Bond in base units: whole tokens at the mint's decimals. */
export const bondUnits = (config: Pick<DisputeConfigAccount, "bondTokens">, decimals: number) =>
  BigInt(config.bondTokens.toString()) * BigInt(10) ** BigInt(decimals);

export type MarketFamily = "binary" | "multi";
/** A binary ruling: keep the proposal, choose YES/NO, or invalid. */
export type BinaryRuling = "uphold" | "invalid" | "yes" | "no";
/** A multi-outcome ruling: keep, invalid, or an outcome index. */
export type MultiRuling = "uphold" | "invalid" | number;
const binaryRuling = (r: BinaryRuling) =>
  r === "uphold" || r === "invalid" ? { [r]: {} } : { overturn: [{ [r]: {} }] };
const multiRuling = (r: MultiRuling) =>
  typeof r === "number" ? { overturn: [[r]] } : { [r]: {} };

export const setDisputeConfigInstruction = (
  p: Program,
  superAdmin: PublicKey,
  config: DisputeConfigAccount,
): Promise<TransactionInstruction> =>
  p.methods
    .setDisputeConfig(
      config.clubWindowSeconds,
      config.regularWindowSeconds,
      config.bondTokens,
      config.rulingDeadlineSeconds,
      config.treasury,
    )
    .accountsPartial({
      superAdmin,
      disputeConfig: disputeConfigPda(),
      systemProgram: SystemProgram.programId,
    })
    .instruction();

/** Opens a dispute, paying the bond from the disputer's token account. */
export function openDisputeInstruction(
  p: Program,
  family: MarketFamily,
  disputer: PublicKey,
  market: PublicKey,
  mint: PublicKey,
  disputerToken: PublicKey,
): Promise<TransactionInstruction> {
  const position =
    family === "binary"
      ? address("prediction_position", market.toBytes(), disputer.toBytes())
      : address("multi_position", market.toBytes(), disputer.toBytes());
  const accounts = {
    disputer,
    market,
    dispute: marketDisputePda(market),
    position,
    disputeConfig: disputeConfigPda(),
    mint,
    disputerToken,
    bondVault: disputeBondPda(market),
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
  return (
    family === "binary"
      ? p.methods.openPredictionDispute()
      : p.methods.openMultiOutcomeDispute()
  )
    .accountsStrict(accounts)
    .instruction();
}

/** Rules on an open dispute. `recipient` is the treasury's token account when
 * upholding, otherwise the disputer's; `club` is the club of a club market. */
export function ruleDisputeInstruction(
  p: Program,
  family: MarketFamily,
  admin: PublicKey,
  market: PublicKey,
  ruling: BinaryRuling | MultiRuling,
  recipient: PublicKey,
  disputer: PublicKey,
  club: PublicKey | null,
): Promise<TransactionInstruction> {
  const common = {
    admin,
    adminRecord: adminRecordPda(admin),
    market,
    dispute: marketDisputePda(market),
    disputeConfig: disputeConfigPda(),
    bondVault: disputeBondPda(market),
    recipient,
    disputer,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  if (family === "multi")
    return p.methods
      .ruleMultiOutcomeDispute(multiRuling(ruling as MultiRuling))
      .accountsStrict(common)
      .instruction();
  return p.methods
    .rulePredictionDispute(binaryRuling(ruling as BinaryRuling))
    .accountsStrict({
      ...common,
      clubMarket: clubMarketPda(market),
      // Read only for club markets; any address otherwise.
      adminClubMember: club ? clubMemberPda(club, admin) : PROGRAM_ID,
    })
    .instruction();
}

/** Makes the market invalid after the ruling deadline (anyone). */
export function expireDisputeInstruction(
  p: Program,
  family: MarketFamily,
  market: PublicKey,
  recipient: PublicKey,
  disputer: PublicKey,
): Promise<TransactionInstruction> {
  const accounts = {
    market,
    dispute: marketDisputePda(market),
    bondVault: disputeBondPda(market),
    recipient,
    disputer,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  return (
    family === "binary"
      ? p.methods.expirePredictionDispute()
      : p.methods.expireMultiOutcomeDispute()
  )
    .accountsStrict(accounts)
    .instruction();
}
