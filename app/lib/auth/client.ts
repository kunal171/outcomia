import { IndexerUnavailableError } from "../graphql/client";

/** The signed-in user: a Solana wallet, Canton parties, or both. */
export type WalletUser = {
  id: string;
  /** Solana wallet; null for a user who signed in with Canton only. */
  wallet: string | null;
  /** Canton parties proven on the ledger. */
  parties: string[];
};

export async function callWalletAuth<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/indexer/auth/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.any([
        AbortSignal.timeout(5000),
        ...(signal ? [signal] : []),
      ]),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new IndexerUnavailableError(
      "Wallet sign-in is temporarily unavailable",
    );
  }
  if ([408, 429].includes(response.status) || response.status >= 500)
    throw new IndexerUnavailableError(
      "Wallet sign-in is temporarily unavailable",
    );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? "Wallet sign-in failed");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
