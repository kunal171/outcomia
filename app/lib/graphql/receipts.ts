import type { Connection, PublicKey } from "@solana/web3.js";
import { hasRpcFallback, readWithRpcFallback } from "../read-source";
import { graphql, INDEXER_ENABLED } from "./client";
type PendingTransaction = { signature: string; lastValidBlockHeight?: number };
const pendingTransactions = new Map<string, PendingTransaction>();
const storagePrefix = "outcomia:pending-indexed-transaction:";

function pendingTransaction(key: string): PendingTransaction | undefined {
  const memory = pendingTransactions.get(key);
  if (memory) return memory;
  try {
    const stored = window.sessionStorage.getItem(storagePrefix + key);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored);
      if (typeof parsed?.signature === "string") return parsed;
    } catch {
      /* Preserve pending signatures saved by the earlier client. */
    }
    return { signature: stored };
  } catch {
    return undefined;
  }
}

function setPendingTransaction(
  key: string,
  signature: string | null,
  lastValidBlockHeight?: number,
) {
  const previous = pendingTransaction(key);
  const record = signature ? {
    signature,
    lastValidBlockHeight: lastValidBlockHeight ??
      (previous?.signature === signature ? previous.lastValidBlockHeight : undefined),
  } : undefined;
  if (record) pendingTransactions.set(key, record);
  else pendingTransactions.delete(key);
  try {
    if (record) window.sessionStorage.setItem(storagePrefix + key, JSON.stringify(record));
    else window.sessionStorage.removeItem(storagePrefix + key);
  } catch { /* Memory protection remains when browser storage is disabled. */ }
}

/** Capture the signed transaction before an RPC reply can be lost. */
export function rememberBroadcast(
  owner: PublicKey,
  signature: string,
  lastValidBlockHeight?: number,
) {
  setPendingTransaction(owner.toBase58(), signature, lastValidBlockHeight);
}

/** A definitive preflight simulation rejection has not broadcast this attempt. */
export function forgetRejectedBroadcast(owner: PublicKey, signature: string) {
  const key = owner.toBase58();
  if (pendingTransaction(key)?.signature === signature) setPendingTransaction(key, null);
}
function isApplied(status: string) {
  return ["CONFIRMED_INDEXED", "FINALIZED_INDEXED", "CONFIRMED_RPC", "FINALIZED_RPC"].includes(status);
}

function settledRpcStatus(status: { err: unknown; confirmationStatus?: string | null } | null) {
  if (!status || !["confirmed", "finalized"].includes(status.confirmationStatus ?? ""))
    return "PENDING_INDEXING";
  if (status.err !== null) return status.err === undefined ? "PENDING_INDEXING" : "FAILED";
  return status.confirmationStatus === "finalized" ? "FINALIZED_RPC" : "CONFIRMED_RPC";
}

async function transactionStatus(
  signature: string,
  signal?: AbortSignal,
  connection?: Connection,
  lastValidBlockHeight?: number,
) {
  const rpc = async () => {
    const result = await connection!.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = result.value[0];
    const settled = settledRpcStatus(status);
    if (settled !== "PENDING_INDEXING") return settled;
    // Only an absent transaction with a provably expired recent blockhash can
    // release the guard. A processed transaction may still become confirmed.
    if (status === null && lastValidBlockHeight !== undefined &&
      await connection!.getBlockHeight("finalized") > lastValidBlockHeight) {
      const recheck = await connection!.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const current = recheck.value[0];
      const checked = settledRpcStatus(current);
      if (checked !== "PENDING_INDEXING") return checked;
      if (current === null && recheck.context.slot >= result.context.slot) return "EXPIRED";
    }
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
    if (result.transaction.status === "PENDING_INDEXING" && connection) {
      if (hasRpcFallback()) return rpc();
      if (lastValidBlockHeight !== undefined) {
        const checked = await rpc();
        if (checked === "EXPIRED" || checked === "FAILED") return checked;
      }
    }
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
  const status = await transactionStatus(pending.signature, undefined, connection, pending.lastValidBlockHeight).catch(
    () => "PENDING_INDEXING",
  );
  if (isApplied(status) || status === "FAILED" || status === "EXPIRED")
    setPendingTransaction(key, null);
  if (status === "EXPIRED")
    throw new Error("The previous transaction expired without confirmation. Refresh and review before retrying.");
  if (status === "FAILED")
    throw new Error(
      `The previous transaction failed. Refresh and review before retrying: ${pending.signature}`,
    );
  throw new Error(
    isApplied(status)
      ? "The previous transaction is confirmed. Refresh and review your next action."
      : `A confirmed transaction is still being indexed. Do not resubmit it: ${pending.signature}`,
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
      pendingTransaction(key)?.lastValidBlockHeight,
    ).catch(() => "PENDING_INDEXING");
    if (isApplied(status)) {
      if (pendingTransaction(key)?.signature === signature)
        setPendingTransaction(key, null);
      return;
    }
    if (status === "EXPIRED") {
      setPendingTransaction(key, null);
      throw new Error(`Transaction expired without confirmation. Refresh and review before retrying: ${signature}`);
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
    let signature: string;
    try {
      signature = await send();
    } catch (error) {
      const pending = pendingTransaction(key);
      if (pending)
        throw new Error(`Transaction result is uncertain. Do not resubmit it: ${pending.signature}`, { cause: error });
      throw error;
    }
    await waitForIndexedTransaction(owner, signature, connection);
    return signature;
  } finally {
    activeSends.delete(key);
  }
}
