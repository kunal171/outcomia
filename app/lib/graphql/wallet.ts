import type { PublicKey } from "@solana/web3.js";
import { graphql, dedupe } from "./client";
export type IndexedAsset = {
  mint: string;
  tokenProgram: string;
  amount: string;
  frozen: string;
  decimals: number;
  accountCount: number;
  slot: string;
};
export function walletAssets(owner: PublicKey) {
  return dedupe(`wallet:${owner}`, () =>
    graphql<{ walletAssets: IndexedAsset[] }>(
      `
        query Holdings($owner: String!) {
          walletAssets(owner: $owner)
        }
      `,
      { owner: owner.toBase58() },
    ).then((r) => r.walletAssets),
  );
}
