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
  deriveAdminRecordPda,
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
export const CLUB_JOIN_REQUEST_TTL_SECONDS = 7 * 24 * 60 * 60;
export const CLUB_TOPIC_MAX_BYTES = 32;
export const CLUB_DESCRIPTION_MAX_BYTES = 280;
export const CLUB_REQUEST_NOTE_MAX_BYTES = 140;

export interface ClubAccount {
  clubId: number[];
  owner: PublicKey;
  pendingOwner: PublicKey | null;
  name: string;
  marketPolicy: { adminsOnly?: object; anyMember?: object };
  memberCount: number;
  adminCount: number;
  createdAt: BN;
  /** Missing on clubs created before club types until they are upgraded. */
  kind?: { private?: object; public?: object };
}
export type ClubKind = "public" | "private";
/** A club's type, or null for a club awaiting the one-time upgrade. */
export const clubKind = (club: Pick<ClubAccount, "kind">): ClubKind | null =>
  club.kind ? ("public" in club.kind ? "public" : "private") : null;
/** Platform limits set by the super-admin (docs/club-rules-and-disputes.md). */
export interface ClubRulesAccount {
  publicMemberCap: number;
  privateMemberCap: number;
  maxOwnedClubs: number;
  maxClubAdmins: number;
}
export interface ClubOwnerRecordAccount {
  wallet: PublicKey;
  owned: number;
}
export const memberCap = (rules: ClubRulesAccount, kind: ClubKind) =>
  kind === "public" ? rules.publicMemberCap : rules.privateMemberCap;
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
/** Public (request + approval) or open (join directly) listing of a club.
 * It admits members and appears in discovery only while verified. */
export interface ClubListingAccount {
  club: PublicKey;
  visibility: { public?: object; open?: object };
  topic: string;
  description: string;
  verifiedBy: PublicKey | null;
  updatedAt: BN;
}
export interface ClubJoinRequestAccount {
  club: PublicKey;
  wallet: PublicKey;
  note: string;
  expiresAt: BN;
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
    clubListing: Reader<ClubListingAccount>;
    clubJoinRequest: Reader<ClubJoinRequestAccount>;
    clubRulesConfig: Reader<ClubRulesAccount>;
    clubOwnerRecord: Reader<ClubOwnerRecordAccount>;
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
export const clubRulesPda = () => address("club_rules_config");
export const clubOwnerRecordPda = (wallet: PublicKey) =>
  address("club_owner", wallet.toBytes());
/** Platform club rules, or null before the super-admin sets them. */
export async function readClubRules(p: Program) {
  return clubAccounts(p).clubRulesConfig.fetchNullable(clubRulesPda());
}
/** How many clubs `wallet` owns right now. */
export async function readOwnedClubCount(p: Program, wallet: PublicKey) {
  const record = await clubAccounts(p).clubOwnerRecord.fetchNullable(
    clubOwnerRecordPda(wallet),
  );
  return record?.owned ?? 0;
}
export const clubInvitePda = (club: PublicKey, wallet: PublicKey) =>
  address("club_invite", club.toBytes(), wallet.toBytes());
export const clubListingPda = (club: PublicKey) =>
  address("club_listing", club.toBytes());
export const clubJoinRequestPda = (club: PublicKey, wallet: PublicKey) =>
  address("club_join_request", club.toBytes(), wallet.toBytes());
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
  const [memberships, invites, requests] = await Promise.all([
    a.clubMember.all(byWallet),
    a.clubInvite.all(byWallet),
    a.clubJoinRequest.all(byWallet).catch(() => []),
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
    requests: await Promise.all(
      requests
        .filter((r) => r.account.wallet.equals(wallet))
        .map(async (r) => ({
          address: r.account.club,
          request: r.account,
          club: await load(r.account.club),
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
  const [members, invites, bindings, listing, requests] = await Promise.all([
    a.clubMember.all(byClub),
    a.clubInvite.all(byClub),
    a.clubMarket.all(byClub),
    a.clubListing.fetchNullable(clubListingPda(club)).catch(() => null),
    a.clubJoinRequest.all(byClub).catch(() => []),
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
    listing: listing && listing.club.equals(club) ? listing : null,
    requests: requests.map((r) => r.account).filter((r) => r.club.equals(club)),
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
  kind: ClubKind,
  clubId: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
) {
  const club = clubPda(clubId);
  const instruction = await p.methods
    .createClub(
      Array.from(clubId),
      name,
      kind === "public" ? { public: {} } : { private: {} },
    )
    .accountsPartial({
      owner,
      clubRules: clubRulesPda(),
      ownerRecord: clubOwnerRecordPda(owner),
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
      clubRules: clubRulesPda(),
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
    .accountsPartial({
      owner,
      club,
      member: memberOf(club, wallet),
      clubRules: clubRulesPda(),
    })
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
  currentOwner: PublicKey,
) =>
  p.methods
    .acceptClubOwnership()
    .accountsPartial({
      candidate,
      club,
      candidateMember: memberOf(club, candidate),
      clubRules: clubRulesPda(),
      candidateRecord: clubOwnerRecordPda(candidate),
      previousRecord: clubOwnerRecordPda(currentOwner),
      systemProgram: SystemProgram.programId,
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

// ---- Public and open clubs (Creator Clubs CC1) -------------------------------

export const isOpenListing = (l: Pick<ClubListingAccount, "visibility">) =>
  !!l.visibility.open;
export const listingVerified = (l: Pick<ClubListingAccount, "verifiedBy">) =>
  !!l.verifiedBy;
export const requestExpired = (
  r: Pick<ClubJoinRequestAccount, "expiresAt">,
  now = Math.floor(Date.now() / 1000),
) => now >= r.expiresAt.toNumber();
const utf8 = (text: string) => new TextEncoder().encode(text).length;
/** Mirrors the program's listing checks; returns an English issue or null. */
export function clubListingIssue(topic: string, description: string) {
  if (!topic || topic.trim() !== topic || utf8(topic) > CLUB_TOPIC_MAX_BYTES)
    return "Topics must be trimmed, nonempty and at most 32 bytes.";
  if (
    description.trim() !== description ||
    utf8(description) > CLUB_DESCRIPTION_MAX_BYTES
  )
    return "Descriptions must be trimmed and at most 280 bytes.";
  return null;
}
export function clubRequestNoteIssue(note: string) {
  return note.trim() !== note || utf8(note) > CLUB_REQUEST_NOTE_MAX_BYTES
    ? "Notes must be trimmed and at most 140 bytes."
    : null;
}
/** Verified public and open clubs for discovery, newest listing first.
 * ClubListing stores club at offset 8. */
export async function readClubListings(p: Program) {
  const a = clubAccounts(p);
  const listings = await a.clubListing.all();
  const rows = await Promise.all(
    listings
      .filter(
        ({ publicKey, account }) =>
          listingVerified(account) &&
          clubListingPda(account.club).equals(publicKey),
      )
      .map(async ({ account }) => {
        const club = await a.club.fetchNullable(account.club);
        return club ? { address: account.club, club, listing: account } : null;
      }),
  );
  return rows
    .filter((r): r is NonNullable<typeof r> => !!r)
    .sort((x, y) => y.listing.updatedAt.cmp(x.listing.updatedAt));
}
export const setClubListingInstruction = (
  p: Program,
  owner: PublicKey,
  club: PublicKey,
  open: boolean,
  topic: string,
  description: string,
) =>
  p.methods
    .setClubListing(open ? { open: {} } : { public: {} }, topic, description)
    .accountsPartial({
      owner,
      club,
      listing: clubListingPda(club),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
export const closeClubListingInstruction = (
  p: Program,
  owner: PublicKey,
  club: PublicKey,
) =>
  p.methods
    .closeClubListing()
    .accountsPartial({ owner, club, listing: clubListingPda(club) })
    .instruction();
/** Protocol admins verify (or withdraw verification of) a listing. */
export const verifyClubListingInstruction = (
  p: Program,
  authority: PublicKey,
  club: PublicKey,
  verified: boolean,
) =>
  p.methods
    .verifyClubListing(verified)
    .accountsPartial({
      authority,
      adminRecord: deriveAdminRecordPda(authority),
      listing: clubListingPda(club),
    })
    .instruction();
export const requestClubMembershipInstruction = (
  p: Program,
  wallet: PublicKey,
  club: PublicKey,
  note: string,
) =>
  p.methods
    .requestClubMembership(note)
    .accountsPartial({
      wallet,
      club,
      listing: clubListingPda(club),
      existingMember: memberOf(club, wallet),
      request: clubJoinRequestPda(club, wallet),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
export const approveClubRequestInstruction = (
  p: Program,
  admin: PublicKey,
  club: PublicKey,
  wallet: PublicKey,
) =>
  p.methods
    .approveClubRequest()
    .accountsPartial({
      admin,
      club,
      clubRules: clubRulesPda(),
      adminMember: memberOf(club, admin),
      request: clubJoinRequestPda(club, wallet),
      wallet,
      member: memberOf(club, wallet),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
/** Reject (club admin), cancel (requester) or clear after expiry (anyone). */
export const closeClubRequestInstruction = (
  p: Program,
  closer: PublicKey,
  club: PublicKey,
  wallet: PublicKey,
  asAdmin: boolean,
) =>
  p.methods
    .closeClubRequest()
    .accountsPartial(
      optionalAccounts({
        closer,
        request: clubJoinRequestPda(club, wallet),
        wallet,
        closerMember: asAdmin ? memberOf(club, closer) : null,
      }),
    )
    .instruction();
export const joinOpenClubInstruction = (
  p: Program,
  wallet: PublicKey,
  club: PublicKey,
) =>
  p.methods
    .joinOpenClub()
    .accountsPartial({
      wallet,
      club,
      clubRules: clubRulesPda(),
      listing: clubListingPda(club),
      member: memberOf(club, wallet),
      systemProgram: SystemProgram.programId,
    })
    .instruction();

// ----- Platform club rules (super-admin) -----
export const setClubRulesInstruction = (
  p: Program,
  superAdmin: PublicKey,
  rules: ClubRulesAccount,
) =>
  p.methods
    .setClubRules(
      rules.publicMemberCap,
      rules.privateMemberCap,
      rules.maxOwnedClubs,
      rules.maxClubAdmins,
    )
    .accountsPartial({
      superAdmin,
      clubRules: clubRulesPda(),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
/** One-time upgrade of a club created before club types. */
export const migrateClubInstruction = (
  p: Program,
  superAdmin: PublicKey,
  club: PublicKey,
  owner: PublicKey,
  kind: ClubKind,
) =>
  p.methods
    .migrateClub(kind === "public" ? { public: {} } : { private: {} }, owner)
    .accountsPartial({
      superAdmin,
      club,
      listing: clubListingPda(club),
      ownerRecord: clubOwnerRecordPda(owner),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
