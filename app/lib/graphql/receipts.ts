import type { Connection, PublicKey } from "@solana/web3.js";
import { hasRpcFallback, readWithRpcFallback } from "../read-source";
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
function isApplied(status: string) {
  return ["CONFIRMED_INDEXED", "FINALIZED_INDEXED", "CONFIRMED_RPC", "FINALIZED_RPC"].includes(status);
}

async function transactionStatus(
  signature: string,
  signal?: AbortSignal,
  connection?: Connection,
) {
  const rpc = async () => {
    const result = await connection!.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = result.value[0];
    if (status?.err) return "FAILED";
    if (status?.confirmationStatus === "finalized") return "FINALIZED_RPC";
    if (status?.confirmationStatus === "confirmed") return "CONFIRMED_RPC";
    return "PENDING_INDEXING";
  };
  const indexed = async () => {
    const result = await graphql<{ transaction: { status: string } }>(
      `
        query Receipt($signature: String!) {
          transaction(signature: $signature)
        }
      `,
      { signature },
      signal,
    );
    if (result.transaction.status === "PENDING_INDEXING" && connection && hasRpcFallback())
      return rpc();
    return result.transaction.status;
  };
  return connection ? readWithRpcFallback("receipts", indexed, rpc) : indexed();
}
/** A timed-out receipt must never become an automatic duplicate wallet send. */
export async function checkPendingTransaction(owner: PublicKey, connection?: Connection) {
  if (!INDEXER_ENABLED) return;
  const key = owner.toBase58(),
    pending = pendingTransaction(key);
  if (!pending) return;
  const status = await transactionStatus(pending, undefined, connection).catch(
    () => "PENDING_INDEXING",
  );
  if (isApplied(status) || status === "FAILED")
    setPendingTransaction(key, null);
  if (status === "FAILED")
    throw new Error(
      `The previous transaction failed. Refresh and review before retrying: ${pending}`,
    );
  throw new Error(
    isApplied(status)
      ? "The previous transaction is confirmed. Refresh and review your next action."
      : `A confirmed transaction is still being indexed. Do not resubmit it: ${pending}`,
  );
}
export async function waitForIndexedTransaction(
  owner: PublicKey,
  signature: string,
  connection?: Connection,
) {
  if (!INDEXER_ENABLED) return;
  const key = owner.toBase58();
  setPendingTransaction(key, signature);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const status = await transactionStatus(
      signature,
      AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
      connection,
    ).catch(() => "PENDING_INDEXING");
    if (isApplied(status)) {
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
  connection?: Connection,
) {
  if (!INDEXER_ENABLED) return send();
  const key = owner.toBase58();
  if (activeSends.has(key))
    throw new Error("The previous wallet action is still pending. Wait before retrying.");
  activeSends.add(key);
  try {
    await checkPendingTransaction(owner, connection);
    const signature = await send();
    await waitForIndexedTransaction(owner, signature, connection);
    return signature;
  } finally {
    activeSends.delete(key);
  }
}
