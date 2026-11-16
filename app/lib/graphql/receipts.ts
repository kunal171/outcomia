import type { PublicKey } from "@solana/web3.js";
import { graphql, INDEXER_ENABLED } from "./client";
const pendingTransactions = new Map<string, string>();
async function transactionStatus(signature: string, signal?: AbortSignal) {
  const result = await graphql<{ transaction: { status: string } }>(
    `
      query Receipt($signature: String!) {
        transaction(signature: $signature)
      }
    `,
    { signature },
    signal,
  );
  return result.transaction.status;
}
/** A timed-out receipt must never become an automatic duplicate wallet send. */
export async function checkPendingTransaction(owner: PublicKey) {
  if (!INDEXER_ENABLED) return;
  const key = owner.toBase58(),
    pending = pendingTransactions.get(key);
  if (!pending) return;
  const status = await transactionStatus(pending).catch(
    () => "PENDING_INDEXING",
  );
  if (status.endsWith("_INDEXED") || status === "FAILED")
    pendingTransactions.delete(key);
  throw new Error(
    status.endsWith("_INDEXED")
      ? "The previous transaction is indexed. Refresh and review your next action."
      : `A confirmed transaction is still being indexed. Do not resubmit it: ${pending}`,
  );
}
export async function waitForIndexedTransaction(
  owner: PublicKey,
  signature: string,
) {
  if (!INDEXER_ENABLED) return;
  const key = owner.toBase58();
  pendingTransactions.set(key, signature);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const status = await transactionStatus(
      signature,
      AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
    ).catch(() => "PENDING_INDEXING");
    if (status.endsWith("_INDEXED")) {
      if (pendingTransactions.get(key) === signature)
        pendingTransactions.delete(key);
      return;
    }
    if (status === "FAILED") {
      pendingTransactions.delete(key);
      throw new Error(`The transaction failed: ${signature}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Transaction confirmed; indexed data is catching up. Do not resubmit it: ${signature}`,
  );
}
