import { graphql, dedupe } from "./client";

export type AccountRecord = {
  address: string;
  accountType: string;
  data: unknown;
};

export type AccountPage = {
  nodes: AccountRecord[];
  sync: { revision: string };
  hasNextPage: boolean;
  endCursor: string | null;
};

export type AccountFilter = { offset: number; bytes: string };

export function getAccount(address: string) {
  return dedupe(`account:${address}`, () =>
    graphql<{ account: AccountRecord | null }>(
      `
        query GetAccount($address: String!) {
          account(address: $address) {
            address
            accountType
            data
          }
        }
      `,
      { address },
    ).then((result) => result.account),
  );
}

export function getAccounts(
  accountType: string,
  filters?: AccountFilter[],
  after: string | null = null,
  revision: string | null = null,
) {
  return graphql<{ accounts: AccountPage }>(
    `
      query GetAccounts(
        $type: String!
        $filters: [Memcmp!]
        $after: String
        $revision: String
      ) {
        accounts(
          accountType: $type
          filters: $filters
          after: $after
          revision: $revision
          first: 500
        ) {
          nodes {
            address
            accountType
            data
          }
          sync {
            revision
          }
          hasNextPage
          endCursor
        }
      }
    `,
    { type: accountType, filters, after, revision },
  ).then((result) => result.accounts);
}

export type RawAccount = {
  rawBase64: string;
  owner: string;
  lamports: string;
};

export function getRawAccounts(keys: string[]) {
  return graphql<{ rawAccounts: (RawAccount | null)[] }>(
    `
      query GetRawAccounts($keys: [String!]!) {
        rawAccounts(addresses: $keys)
      }
    `,
    { keys },
  ).then((result) => result.rawAccounts);
}
