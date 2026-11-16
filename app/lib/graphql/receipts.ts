import type { PublicKey } from "@solana/web3.js";
import { graphql, INDEXER_ENABLED } from "./client";
const pendingTransactions = new Map<string, string>();
const storagePrefix = "outcomia:pending-indexed-transaction:";

function pendingTransaction(key: string) {
  try {
    return (
      pendingTransactions.get(key) ??
      window.sessionStorage.getItem(storagePrefix + key)
    );
  } catch {
    return pendingTransactions.get(key);
  }
}

function setPendingTransaction(key: string, signature: string | null) {
  if (signature) pendingTransactions.set(key, signature);
  else pendingTransactions.delete(key);
  try {
    if (signature) window.sessionStorage.setItem(storagePrefix + key, signature);
    else window.sessionStorage.removeItem(storagePrefix + key);
  } catch {
    // Memory protection remains available when browser storage is disabled.
  }
}
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
    pending = pendingTransaction(key);
  if (!pending) return;
  const status = await transactionStatus(pending).catch(
    () => "PENDING_INDEXING",
  );
  if (status.endsWith("_INDEXED") || status === "FAILED")
    setPendingTransaction(key, null);
  if (status === "FAILED")
    throw new Error(
      `The previous transaction failed. Refresh and review before retrying: ${pending}`,
    );
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
  setPendingTransaction(key, signature);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const status = await transactionStatus(
      signature,
      AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
    ).catch(() => "PENDING_INDEXING");
    if (status.endsWith("_INDEXED")) {
      if (pendingTransaction(key) === signature)
        setPendingTransaction(key, null);
      return;
    }
    if (status === "FAILED") {
      setPendingTransaction(key, null);
      throw new Error(`The transaction failed: ${signature}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Transaction confirmed; indexed data is catching up. Do not resubmit it: ${signature}`,
  );
}

const activeSends = new Set<string>();

/** Apply the same convergence rule to every wallet-backed program action. */
export async function sendWithIndexedReceipt(
  owner: PublicKey,
  send: () => Promise<string>,
) {
  if (!INDEXER_ENABLED) return send();
  const key = owner.toBase58();
  if (activeSends.has(key))
    throw new Error("The previous wallet action is still pending. Wait before retrying.");
  activeSends.add(key);
  try {
    await checkPendingTransaction(owner);
    const signature = await send();
    await waitForIndexedTransaction(owner, signature);
    return signature;
  } finally {
    activeSends.delete(key);
  }
}
