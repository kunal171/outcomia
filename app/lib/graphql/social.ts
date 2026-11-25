/** Profiles, leaderboards and trader stats from the indexer. Amounts are raw
 * atoms of one mint, as strings; format them with that mint's decimals. */
import { graphql } from "./client";

export type Profile = {
  wallet: string;
  username: string;
  displayName: string;
  bio: string;
  avatarHue: number;
  xHandle: string | null;
  showOnLeaderboards: boolean;
  createdAt: string;
};
const PROFILE =
  "wallet username displayName bio avatarHue xHandle showOnLeaderboards createdAt";

export type ProfileInput = Omit<Profile, "wallet" | "createdAt">;
export type Period = "DAY" | "WEEK" | "MONTH" | "ALL";
export type TraderBoard =
  "VOLUME" | "ACTIVITY" | "MAKERS" | "PROFIT" | "ACCURACY";

export type MintRow = {
  mint: string;
  decimals: number | null;
  symbol: string | null;
  volume: string;
};
export type TraderRow = {
  rank: number;
  wallet: string;
  profile: Profile | null;
  volume: string | null;
  makerVolume: string | null;
  trades: number | null;
  markets: number | null;
  profit: string | null;
  invested: string | null;
  wins: number | null;
  losses: number | null;
};
export type MarketRow = {
  rank: number;
  market: string;
  kind: string;
  title: string | null;
  volume: string;
  trades: number;
  traders: number;
};
export type CallRow = {
  rank: number;
  wallet: string;
  profile: Profile | null;
  market: string;
  kind: string;
  title: string | null;
  outcome: string;
  outcomeLabel: string | null;
  price: string;
  payout: string;
  quantity: string;
  profit: string;
  multiple: string;
  signature: string;
  blockTime: string | null;
};
export type ClubRow = {
  rank: number;
  club: string;
  name: string;
  members: number;
  markets: number;
  volume: string;
  trades: number;
};
export type CreatorRow = {
  rank: number;
  wallet: string;
  profile: Profile | null;
  markets: number;
  volume: string;
  traders: number;
};
export type MintStats = {
  mint: string;
  decimals: number | null;
  volume: string;
  makerVolume: string;
  trades: number;
  markets: number;
  profit: string;
  wins: number;
  losses: number;
};
export type TraderStats = {
  wallet: string;
  profile: Profile | null;
  perMint: MintStats[];
  openPositions: {
    market: string;
    kind: string;
    title: string | null;
    mint: string | null;
    outcome: string;
    outcomeLabel: string | null;
    contracts: string;
  }[];
  settled: {
    market: string;
    kind: string;
    title: string | null;
    mint: string;
    profit: string;
  }[];
  recentTrades: {
    signature: string;
    blockTime: string | null;
    market: string;
    kind: string | null;
    title: string | null;
    mint: string | null;
    outcome: string;
    outcomeLabel: string | null;
    role: string;
    contracts: string;
    price: string;
  }[];
  clubs: { club: string; name: string | null; role: string }[];
};
export type MarketTraderRow = {
  rank: number;
  wallet: string;
  profile: Profile | null;
  volume: string;
  trades: number;
  holdings: { outcome: string; label: string | null; contracts: string }[];
  profit: string | null;
};

export async function getProfile(by: { wallet?: string; username?: string }) {
  const data = await graphql<{ profile: Profile | null }>(
    `query Profile($wallet: String, $username: String) {
      profile(wallet: $wallet, username: $username) { ${PROFILE} }
    }`,
    by,
  );
  return data.profile;
}

export async function getProfiles(wallets: string[]) {
  if (wallets.length === 0) return [];
  const data = await graphql<{ profiles: Profile[] }>(
    `query Profiles($wallets: [String!]!) { profiles(wallets: $wallets) { ${PROFILE} } }`,
    { wallets: wallets.slice(0, 100) },
  );
  return data.profiles;
}

export async function updateProfile(input: ProfileInput) {
  const data = await graphql<{ updateProfile: Profile }>(
    `mutation UpdateProfile($input: ProfileInput!) {
      updateProfile(input: $input) { ${PROFILE} }
    }`,
    { input },
  );
  return data.updateProfile;
}

export async function getLeaderboardMints() {
  const data = await graphql<{
    leaderboardMints: MintRow[];
    leaderboardSlot: string | null;
  }>(`
    {
      leaderboardMints {
        mint
        decimals
        symbol
        volume
      }
      leaderboardSlot
    }
  `);
  return data;
}

export async function getTraderLeaderboard(
  board: TraderBoard,
  period: Period,
  mint: string,
  first = 25,
  offset = 0,
) {
  const data = await graphql<{ traderLeaderboard: TraderRow[] }>(
    `query Traders($board: TraderBoard!, $period: Period!, $mint: String!, $first: Int, $offset: Int) {
      traderLeaderboard(board: $board, period: $period, mint: $mint, first: $first, offset: $offset) {
        rank wallet profile { ${PROFILE} } volume makerVolume trades markets profit invested wins losses
      }
    }`,
    { board, period, mint, first, offset },
  );
  return data.traderLeaderboard;
}

export async function getMarketLeaderboard(
  period: Period,
  mint: string,
  first = 25,
) {
  const data = await graphql<{ marketLeaderboard: MarketRow[] }>(
    `
      query Markets($period: Period!, $mint: String!, $first: Int) {
        marketLeaderboard(period: $period, mint: $mint, first: $first) {
          rank
          market
          kind
          title
          volume
          trades
          traders
        }
      }
    `,
    { period, mint, first },
  );
  return data.marketLeaderboard;
}

export async function getBestCalls(mint: string, first = 25) {
  const data = await graphql<{ bestCalls: CallRow[] }>(
    `query Calls($mint: String!, $first: Int) {
      bestCalls(mint: $mint, first: $first) {
        rank wallet profile { ${PROFILE} } market kind title outcome outcomeLabel
        price payout quantity profit multiple signature blockTime
      }
    }`,
    { mint, first },
  );
  return data.bestCalls;
}

export async function getClubLeaderboard(
  period: Period,
  mint: string,
  first = 25,
) {
  const data = await graphql<{ clubLeaderboard: ClubRow[] }>(
    `
      query Clubs($period: Period!, $mint: String!, $first: Int) {
        clubLeaderboard(period: $period, mint: $mint, first: $first) {
          rank
          club
          name
          members
          markets
          volume
          trades
        }
      }
    `,
    { period, mint, first },
  );
  return data.clubLeaderboard;
}

export async function getCreatorLeaderboard(
  period: Period,
  mint: string,
  first = 25,
) {
  const data = await graphql<{ creatorLeaderboard: CreatorRow[] }>(
    `query Creators($period: Period!, $mint: String!, $first: Int) {
      creatorLeaderboard(period: $period, mint: $mint, first: $first) {
        rank wallet profile { ${PROFILE} } markets volume traders
      }
    }`,
    { period, mint, first },
  );
  return data.creatorLeaderboard;
}

export async function getTraderStats(wallet: string) {
  const data = await graphql<{ traderStats: TraderStats }>(
    `query Stats($wallet: String!) {
      traderStats(wallet: $wallet) {
        wallet profile { ${PROFILE} }
        perMint { mint decimals volume makerVolume trades markets profit wins losses }
        openPositions { market kind title mint outcome outcomeLabel contracts }
        settled { market kind title mint profit }
        recentTrades { signature blockTime market kind title mint outcome outcomeLabel role contracts price }
        clubs { club name role }
      }
    }`,
    { wallet },
  );
  return data.traderStats;
}

export async function getMarketTraders(market: string, first = 25) {
  const data = await graphql<{ marketTraders: MarketTraderRow[] }>(
    `query MarketTraders($market: String!, $first: Int) {
      marketTraders(market: $market, first: $first) {
        rank wallet profile { ${PROFILE} } volume trades holdings { outcome label contracts } profit
      }
    }`,
    { market, first },
  );
  return data.marketTraders;
}
