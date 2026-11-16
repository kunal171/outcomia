import { graphql } from "./client";
import { getAccount, getAccounts, type AccountFilter } from "./accounts";

export const MARKET_ACCOUNT_TYPES = [
  "Market",
  "PredictionMarket",
  "MultiOutcomeMarket",
];

export async function getMarket(address: string) {
  const account = await getAccount(address);
  if (account && !MARKET_ACCOUNT_TYPES.includes(account.accountType))
    throw new Error("Address is not an indexed market");
  return account;
}

export function getMarkets(
  type: string,
  filters?: AccountFilter[],
  after: string | null = null,
  revision: string | null = null,
) {
  if (!MARKET_ACCOUNT_TYPES.includes(type))
    throw new Error("Unsupported market type");
  return getAccounts(type, filters, after, revision);
}

export type LatestTrade = {
  price: string;
  signature: string;
  blockTime: string | null;
};

export function getLatestTrade(market: string, engine: string) {
  return graphql<{ latestTrade: LatestTrade | null }>(
    `
      query GetLatestTrade($market: String!, $engine: String!) {
        latestTrade(market: $market, engine: $engine)
      }
    `,
    { market, engine },
  ).then((result) => result.latestTrade);
}
