/** Club rules milestone 2b: switching a club's type, settling finished club
 * markets and closing a club (docs/club-rules-and-disputes.md, sections 1 and 5).
 * The program enforces every rule; these helpers explain and build. */
import type { Program } from "@anchor-lang/core";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID } from "./solana";
import { TOKEN_PROGRAM_ID } from "./outcomia";
import { optionalAccounts } from "./shared";
import { clubDepositVaultPda } from "./club-deposits";

const address = (seed: string, ...parts: Uint8Array[]) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...parts.map((p) => Buffer.from(p))],
    PROGRAM_ID,
  )[0];
const clubRulesPda = () => address("club_rules_config");
const clubListingPda = (club: PublicKey) => address("club_listing", club.toBytes());
const clubMarketPda = (market: PublicKey) => address("club_market", market.toBytes());
const clubMemberPda = (club: PublicKey, wallet: PublicKey) =>
  address("club_member", club.toBytes(), wallet.toBytes());
const clubOwnerRecordPda = (wallet: PublicKey) =>
  address("club_owner", wallet.toBytes());
/** Settlement record of a club market; it exists once the market is settled. */
export const clubMarketSettlementPda = (market: PublicKey) =>
  address("club_market_settled", clubMarketPda(market).toBytes());

/** The market fields settling depends on. */
export interface SettleableMarket {
  status: Record<string, object>;
  closeTs: { toNumber(): number };
  yesSupply: { isZero(): boolean };
  noSupply: { isZero(): boolean };
  backingReserve: { isZero(): boolean };
}
export type SettleState =
  /** Settled already. */
  | "settled"
  /** Finished with its club fees withdrawn: anyone may settle it. */
  | "ready"
  /** Finished, but its club fees must be withdrawn first. */
  | "fees"
  /** Still open, proposed or a draft that could still open. */
  | "live";
/** Whether a club market can be settled now, as the program decides. */
export function settleState(
  market: SettleableMarket,
  accruedClubFees: { isZero(): boolean },
  settled: boolean,
  nowSeconds: number,
): SettleState {
  if (settled) return "settled";
  const finished =
    "resolved" in market.status ||
    ("draft" in market.status &&
      nowSeconds >= market.closeTs.toNumber() &&
      market.yesSupply.isZero() &&
      market.noSupply.isZero() &&
      market.backingReserve.isZero());
  if (!finished) return "live";
  return accruedClubFees.isZero() ? "ready" : "fees";
}

/** Why a club cannot close yet, or an empty list when it can. */
export function closeBlockers(club: {
  closed?: boolean;
  liveMarketsReady?: boolean;
  liveMarkets?: number;
}): string[] {
  if (club.closed) return ["This club is closed."];
  const issues: string[] = [];
  if (club.liveMarketsReady === false)
    issues.push(
      "The platform admin must record this club's market count first.",
    );
  else if ((club.liveMarkets ?? 0) > 0)
    issues.push(
      "Settle every club market first: each must be resolved with its club fees withdrawn.",
    );
  return issues;
}

/** USDC refund accounts: the owner's token account for the deposit mint. */
export interface UsdcRefund {
  ownerToken: PublicKey;
}
const refundAccounts = (club: PublicKey, usdc: UsdcRefund | null) =>
  optionalAccounts({
    depositVault: usdc ? clubDepositVaultPda(club) : null,
    ownerToken: usdc?.ownerToken ?? null,
    tokenProgram: usdc ? TOKEN_PROGRAM_ID : null,
  });

/** Switches a club's type. A SOL club passes a fresh price; a USDC club that
 * becomes private passes its refund account. */
export const setClubKindInstruction = (
  p: Program,
  owner: PublicKey,
  club: PublicKey,
  kind: "public" | "private",
  priceUpdate: PublicKey | null,
  usdc: UsdcRefund | null,
): Promise<TransactionInstruction> =>
  p.methods
    .setClubKind(kind === "public" ? { public: {} } : { private: {} })
    .accountsPartial({
      owner,
      club,
      clubRules: clubRulesPda(),
      listing: clubListingPda(club),
      ...optionalAccounts({ priceUpdate }),
      ...refundAccounts(club, usdc),
    })
    .instruction();

/** Settles one finished club market; anyone may send it. */
export const settleClubMarketInstruction = (
  p: Program,
  payer: PublicKey,
  club: PublicKey,
  market: PublicKey,
): Promise<TransactionInstruction> =>
  p.methods
    .settleClubMarket()
    .accountsPartial({
      payer,
      club,
      clubMarket: clubMarketPda(market),
      market,
      settlement: clubMarketSettlementPda(market),
    })
    .instruction();

/** Closes a club and refunds its deposit; USDC clubs pass the refund account. */
export const closeClubInstruction = (
  p: Program,
  owner: PublicKey,
  club: PublicKey,
  usdc: UsdcRefund | null,
): Promise<TransactionInstruction> =>
  p.methods
    .closeClub()
    .accountsPartial({
      owner,
      club,
      ownerRecord: clubOwnerRecordPda(owner),
      ownerMember: clubMemberPda(club, owner),
      listing: clubListingPda(club),
      ...refundAccounts(club, usdc),
    })
    .instruction();
