/** Clubs and private markets: addresses, account readers and instruction builders.
 *
 * "Private" means restricted participation, not confidential data: every club
 * account is publicly readable. Hiding a market in the app is never a
 * permission check; the program enforces membership (docs/clubs-private-markets.md). */
import { BN, type Program } from "@anchor-lang/core";
import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import { indexedAccounts } from "./indexed-accounts";
import { PROGRAM_ID } from "./solana";
import {
  SHARED_BALANCES_ENABLED,
  assetAuthorityPda,
  assetBalancePda,
  assetVaultPda,
  clubBookPda,
  clubMemberPda,
  optionalAccounts,
  type ClubTrading,
} from "./shared";
import {
  TOKEN_PROGRAM_ID,
  deriveMarketMetadataPda,
  deriveVaultAuthorityPda,
  deriveVaultPda,
} from "./outcomia";
import type { PredictionMarketAccount } from "./prediction";

/** Keep off until the program with club instructions is deployed. */
export const CLUBS_ENABLED =
  SHARED_BALANCES_ENABLED && process.env.NEXT_PUBLIC_CLUBS_ENABLED === "true";
export const CLUB_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const CLUB_NAME_MAX_BYTES = 64;

export interface ClubAccount {
  clubId: number[];
  owner: PublicKey;
  pendingOwner: PublicKey | null;
  name: string;
  marketPolicy: { adminsOnly?: object; anyMember?: object };
  memberCount: number;
  adminCount: number;
  createdAt: BN;
}
export interface ClubMemberAccount {
  club: PublicKey;
  wallet: PublicKey;
  role: { member?: object; admin?: object };
  joinedAt: BN;
}
export interface ClubInviteAccount {
  club: PublicKey;
  wallet: PublicKey;
  inviter: PublicKey;
  expiresAt: BN;
}
export interface ClubMarketAccount {
  club: PublicKey;
  market: PublicKey;
  access: { membersOnly?: object; public?: object };
  creator: PublicKey;
  accruedClubFees: BN;
}
export interface MarketMetadata {
  market: PublicKey;
  displayName: string;
  quoteSymbol: string;
}
interface Reader<T> {
  fetchNullable(key: PublicKey): Promise<T | null>;
  all(
    filters?: { memcmp: { offset: number; bytes: string } }[],
  ): Promise<{ publicKey: PublicKey; account: T }[]>;
}
export function clubAccounts(p: Program) {
  return indexedAccounts(p) as unknown as {
    club: Reader<ClubAccount>;
    clubMember: Reader<ClubMemberAccount>;
    clubInvite: Reader<ClubInviteAccount>;
    clubMarket: Reader<ClubMarketAccount>;
    predictionMarket: Reader<PredictionMarketAccount>;
    marketMetadata: Reader<MarketMetadata>;
  };
}

const address = (seed: string, ...parts: Uint8Array[]) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...parts.map((p) => Buffer.from(p))],
    PROGRAM_ID,
  )[0];
export const clubPda = (clubId: Uint8Array) => address("club", clubId);
export const clubInvitePda = (club: PublicKey, wallet: PublicKey) =>
  address("club_invite", club.toBytes(), wallet.toBytes());
export const clubMarketPda = (market: PublicKey) =>
  address("club_market", market.toBytes());
export const clubPredictionMarketPda = (marketId: Uint8Array) =>
  address("club_prediction_market", marketId);
export { clubBookPda, clubMemberPda };

/** Public discovery must list only markets at the public seed. Club markets
 * share the account layout, so the address is the only distinction. */
export function isPublicPredictionMarket(
  key: PublicKey,
  marketId: number[] | Uint8Array,
) {
  return address("prediction_market", Uint8Array.from(marketId)).equals(key);
}
export function isClubPredictionMarket(
  key: PublicKey,
  marketId: number[] | Uint8Array,
) {
  return clubPredictionMarketPda(Uint8Array.from(marketId)).equals(key);
}

export const isAdmin = (m: Pick<ClubMemberAccount, "role">) =>
  "admin" in m.role;
export const membersOnly = (m: Pick<ClubMarketAccount, "access">) =>
  "membersOnly" in m.access;
export type ClubRoleName = "owner" | "admin" | "member";
export function clubRole(
  club: Pick<ClubAccount, "owner">,
  member: Pick<ClubMemberAccount, "role" | "wallet"> | null | undefined,
): ClubRoleName | null {
  if (!member) return null;
  if (member.wallet.equals(club.owner)) return "owner";
  return isAdmin(member) ? "admin" : "member";
}
/** Whether `wallet` may create markets under the club's policy. */
export function canCreateClubMarket(
  club: Pick<ClubAccount, "marketPolicy" | "owner">,
  member: Pick<ClubMemberAccount, "role" | "wallet"> | null | undefined,
) {
  return !!member && (isAdmin(member) || "anyMember" in club.marketPolicy);
}
export const inviteExpired = (
  invite: Pick<ClubInviteAccount, "expiresAt">,
  nowSeconds: number,
) => invite.expiresAt.lte(new BN(nowSeconds));
/** Byte-accurate version of the program's name rule. */
export function clubNameIssue(name: string) {
  const bytes = new TextEncoder().encode(name).length;
  if (!name || name.trim() !== name || bytes > CLUB_NAME_MAX_BYTES)
    return "Club names must be trimmed, nonempty and at most 64 bytes";
  return null;
}

/** Clubs the wallet belongs to and invitations addressed to it.
 * ClubMember and ClubInvite store club at offset 8 and wallet at offset 40. */
export async function readWalletClubs(p: Program, wallet: PublicKey) {
  const a = clubAccounts(p);
  const byWallet = [{ memcmp: { offset: 40, bytes: wallet.toBase58() } }];
  const [memberships, invites] = await Promise.all([
    a.clubMember.all(byWallet),
    a.clubInvite.all(byWallet),
  ]);
  const load = async (club: PublicKey) => {
    const account = await a.club.fetchNullable(club);
    if (!account) throw new Error("Club account is missing");
    return account;
  };
  return {
    clubs: await Promise.all(
      memberships
        .filter((m) => m.account.wallet.equals(wallet))
        .map(async (m) => ({
          address: m.account.club,
          club: await load(m.account.club),
          member: m.account,
        })),
    ),
    invites: await Promise.all(
      invites
        .filter((i) => i.account.wallet.equals(wallet))
        .map(async (i) => ({
          address: i.publicKey,
          invite: i.account,
          club: await load(i.account.club),
        })),
    ),
  };
}

export interface ClubMarketRow {
  address: PublicKey;
  binding: ClubMarketAccount;
  market: PredictionMarketAccount;
  metadata: MarketMetadata | null;
}
/** One club with its members, pending invitations and markets. */
export async function readClub(p: Program, club: PublicKey) {
  const a = clubAccounts(p);
  const account = await a.club.fetchNullable(club);
  if (!account) return null;
  if (!clubPda(Uint8Array.from(account.clubId)).equals(club))
    throw new Error("Club address does not match its id");
  const byClub = [{ memcmp: { offset: 8, bytes: club.toBase58() } }];
  const [members, invites, bindings] = await Promise.all([
    a.clubMember.all(byClub),
    a.clubInvite.all(byClub),
    a.clubMarket.all(byClub),
  ]);
  const markets: ClubMarketRow[] = [];
  for (const { account: binding } of bindings) {
    if (!binding.club.equals(club)) continue;
    const market = await a.predictionMarket.fetchNullable(binding.market);
    if (!market || !isClubPredictionMarket(binding.market, market.marketId))
      continue;
    markets.push({
      address: binding.market,
      binding,
      market,
      metadata: await a.marketMetadata.fetchNullable(market.metadata),
    });
  }
  return {
    address: club,
    club: account,
    members: members
      .map((m) => m.account)
      .filter((m) => m.club.equals(club))
      .sort(
        (x, y) =>
          Number(y.wallet.equals(account.owner)) -
            Number(x.wallet.equals(account.owner)) ||
          Number(isAdmin(y)) - Number(isAdmin(x)),
      ),
    invites: invites.map((i) => i.account).filter((i) => i.club.equals(club)),
    markets,
  };
}
export type ClubSnapshot = NonNullable<Awaited<ReturnType<typeof readClub>>>;

/** The trading context the shared planner needs for a club market. */
export function clubTrading(
  snapshot: ClubSnapshot,
  binding: ClubMarketAccount,
): ClubTrading {
  return {
    club: snapshot.address,
    clubMarket: clubMarketPda(binding.market),
    membersOnly: membersOnly(binding),
    members: new Set(snapshot.members.map((m) => m.wallet.toBase58())),
  };
}

/** Club context for an order owner's own actions (cancel, exits) in a club
 * market, or null for a public market. Owner actions never depend on the
 * member list, so it is left empty. */
export async function ownerClubContext(
  p: Program,
  market: PublicKey,
): Promise<ClubTrading | null> {
  const clubMarket = clubMarketPda(market);
  const binding = await clubAccounts(p).clubMarket.fetchNullable(clubMarket);
  if (!binding) return null;
  if (!binding.market.equals(market))
    throw new Error("Club market binding mismatch");
  return {
    club: binding.club,
    clubMarket,
    membersOnly: membersOnly(binding),
    members: new Set(),
  };
}
export const clubMarketHref = (club: PublicKey, market: PublicKey) =>
  `/clubs/${club.toBase58()}/markets/${market.toBase58()}`;

// ----- Club administration -----
const memberOf = (club: PublicKey, wallet: PublicKey) =>
  clubMemberPda(club, wallet);

export async function createClubInstruction(
  p: Program,
  owner: PublicKey,
  name: string,
  clubId: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
) {
  const club = clubPda(clubId);
  const instruction = await p.methods
    .createClub(Array.from(clubId), name)
    .accountsPartial({
      owner,
      club,
      ownerMember: memberOf(club, owner),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { club, instruction };
}
export const setClubMarketPolicyInstruction = (
  p: Program,
  admin: PublicKey,
  club: PublicKey,
  anyMember: boolean,
) =>
  p.methods
    .setClubMarketPolicy(anyMember ? { anyMember: {} } : { adminsOnly: {} })
    .accountsPartial({ admin, club, adminMember: memberOf(club, admin) })
    .instruction();
export const inviteClubMemberInstruction = (
  p: Program,
  inviter: PublicKey,
  club: PublicKey,
  wallet: PublicKey,
) =>
  p.methods
    .inviteClubMember(wallet)
    .accountsPartial({
      inviter,
      club,
      inviterMember: memberOf(club, inviter),
      existingMember: memberOf(club, wallet),
      invite: clubInvitePda(club, wallet),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
export const acceptClubInviteInstruction = (
  p: Program,
  wallet: PublicKey,
  invite: Pick<ClubInviteAccount, "club" | "inviter">,
) =>
  p.methods
    .acceptClubInvite()
    .accountsPartial({
      wallet,
      club: invite.club,
      invite: clubInvitePda(invite.club, wallet),
      inviter: invite.inviter,
      member: memberOf(invite.club, wallet),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
/** Revoke (club admin), decline (the invited wallet) or clear after expiry (anyone). */
export const closeClubInviteInstruction = (
  p: Program,
  closer: PublicKey,
  invite: Pick<ClubInviteAccount, "club" | "wallet" | "inviter">,
  asAdmin: boolean,
) =>
  p.methods
    .closeClubInvite()
    .accountsPartial(
      optionalAccounts({
        closer,
        invite: clubInvitePda(invite.club, invite.wallet),
        inviter: invite.inviter,
        closerMember: asAdmin ? memberOf(invite.club, closer) : null,
      }),
    )
    .instruction();
export const setClubMemberRoleInstruction = (
  p: Program,
  owner: PublicKey,
  club: PublicKey,
  wallet: PublicKey,
  admin: boolean,
) =>
  p.methods
    .setClubMemberRole(admin ? { admin: {} } : { member: {} })
    .accountsPartial({ owner, club, member: memberOf(club, wallet) })
    .instruction();
export const removeClubMemberInstruction = (
  p: Program,
  admin: PublicKey,
  club: PublicKey,
  wallet: PublicKey,
) =>
  p.methods
    .removeClubMember()
    .accountsPartial({
      admin,
      club,
      adminMember: memberOf(club, admin),
      member: memberOf(club, wallet),
      wallet,
    })
    .instruction();
export const leaveClubInstruction = (
  p: Program,
  wallet: PublicKey,
  club: PublicKey,
) =>
  p.methods
    .leaveClub()
    .accountsPartial({ wallet, club, member: memberOf(club, wallet) })
    .instruction();
/** Nominating the owner itself cancels a pending nomination. */
export const nominateClubOwnerInstruction = (
  p: Program,
  owner: PublicKey,
  club: PublicKey,
  candidate: PublicKey,
) =>
  p.methods
    .nominateClubOwner()
    .accountsPartial({
      owner,
      club,
      candidateMember: memberOf(club, candidate),
    })
    .instruction();
export const acceptClubOwnershipInstruction = (
  p: Program,
  candidate: PublicKey,
  club: PublicKey,
) =>
  p.methods
    .acceptClubOwnership()
    .accountsPartial({
      candidate,
      club,
      candidateMember: memberOf(club, candidate),
    })
    .instruction();
export const withdrawClubFeesInstruction = (
  p: Program,
  owner: PublicKey,
  club: PublicKey,
  market: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  amount: BN,
) =>
  p.methods
    .withdrawClubFees(amount)
    .accountsPartial({
      owner,
      club,
      clubMarket: clubMarketPda(market),
      market,
      mint,
      destination,
      vaultAuthority: assetAuthorityPda(mint),
      assetVault: assetVaultPda(mint),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

// ----- Club markets -----
export interface ClubMarketTerms {
  resolver: PublicKey;
  fallback: null;
  closeTs: BN;
  earliestResolutionTs: BN | null;
  resolutionDelaySeconds: BN;
  payoutPerContract: BN;
  priceTick: BN;
  rulesUri: string;
  questionHash: number[];
  rulesHash: number[];
}
/** Creates the draft, opens it and creates its book in one transaction, so a
 * club market is tradable as soon as it exists. */
export async function createClubMarketInstructions(
  p: Program,
  creator: PublicKey,
  club: PublicKey,
  collateralMint: PublicKey,
  terms: ClubMarketTerms,
  displayName: string,
  collateralSymbol: string,
  publicAccess: boolean,
  marketId: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
) {
  const market = clubPredictionMarketPda(marketId);
  const clubMarket = clubMarketPda(market);
  const manage = {
    actor: creator,
    clubMarket,
    market,
    actorMember: memberOf(club, creator),
  };
  const instructions: TransactionInstruction[] = [
    await p.methods
      .createClubPredictionMarket(
        Array.from(marketId),
        terms,
        displayName,
        collateralSymbol,
        publicAccess ? { public: {} } : { membersOnly: {} },
      )
      .accountsPartial({
        creator,
        club,
        creatorMember: memberOf(club, creator),
        market,
        clubMarket,
        collateralMint,
        vaultAuthority: deriveVaultAuthorityPda(market),
        collateralVault: deriveVaultPda(market, collateralMint),
        marketMetadata: deriveMarketMetadataPda(market),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    await p.methods
      .openClubPredictionMarket()
      .accountsPartial(manage)
      .instruction(),
    await p.methods
      .initializeClubBook()
      .accountsPartial({
        ...manage,
        book: clubBookPda(market),
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  ];
  return { market, instructions };
}
export const closeClubTradingInstruction = (
  p: Program,
  actor: PublicKey,
  club: PublicKey,
  market: PublicKey,
) =>
  p.methods
    .closeClubTrading()
    .accountsPartial({
      actor,
      clubMarket: clubMarketPda(market),
      market,
      actorMember: memberOf(club, actor),
    })
    .instruction();
export const initializeClubPositionInstruction = (
  p: Program,
  owner: PublicKey,
  market: PublicKey,
  position: PublicKey,
) =>
  p.methods
    .initializeClubPosition()
    .accountsPartial({
      owner,
      market,
      position,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
function custody(
  owner: PublicKey,
  club: ClubTrading,
  market: PublicKey,
  mint: PublicKey,
  position: PublicKey,
  withMember: boolean,
) {
  return optionalAccounts({
    owner,
    market,
    clubMarket: club.clubMarket,
    member: withMember && club.membersOnly ? memberOf(club.club, owner) : null,
    position,
    mint,
    assetBalance: assetBalancePda(owner, mint),
    assetAuthority: assetAuthorityPda(mint),
    assetVault: assetVaultPda(mint),
    marketAuthority: deriveVaultAuthorityPda(market),
    marketVault: deriveVaultPda(market, mint),
    tokenProgram: TOKEN_PROGRAM_ID,
  });
}
/** Split (members only in members-only markets) or merge (always open). */
export const clubCompleteSetInstruction = (
  p: Program,
  owner: PublicKey,
  club: ClubTrading,
  market: PublicKey,
  mint: PublicKey,
  position: PublicKey,
  quantity: BN,
  split: boolean,
) =>
  p.methods
    .clubCompleteSet(quantity, split)
    .accountsPartial(custody(owner, club, market, mint, position, split))
    .instruction();
/** Redemption never needs membership. */
export const redeemClubPredictionInstruction = (
  p: Program,
  owner: PublicKey,
  club: ClubTrading,
  market: PublicKey,
  mint: PublicKey,
  position: PublicKey,
  yes: BN,
  no: BN,
) =>
  p.methods
    .redeemClubPrediction(yes, no)
    .accountsPartial(custody(owner, club, market, mint, position, false))
    .instruction();
export const proposeClubPredictionInstruction = (
  p: Program,
  admin: PublicKey,
  club: PublicKey,
  market: PublicKey,
  outcome: "yes" | "no" | "invalid",
  evidenceUri: string,
  evidenceHash: number[],
  correction: boolean,
) =>
  p.methods
    .proposeClubPrediction(
      { [outcome]: {} },
      evidenceUri,
      evidenceHash,
      correction,
    )
    .accountsPartial({
      admin,
      clubMarket: clubMarketPda(market),
      market,
      adminMember: memberOf(club, admin),
    })
    .instruction();
/** 0 freezes at the cutoff, 2 finalizes a mature proposal. */
export const advanceClubPredictionInstruction = (
  p: Program,
  market: PublicKey,
  action: 0 | 2,
) =>
  p.methods
    .advanceClubPrediction(action)
    .accountsPartial({ market })
    .instruction();
