/** Shared HTTP transport and in-flight deduplication. Resolvers stay on the indexer. */
export const INDEXER_ENABLED =
  process.env.NEXT_PUBLIC_INDEXER_ENABLED === "true";
/** Availability failures allow read adapters to use their existing RPC reader. */
export class IndexerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexerUnavailableError";
  }
}

export async function graphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/indexer/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new IndexerUnavailableError("Indexed data service is unreachable");
  }
  if ([408, 429].includes(response.status) || response.status >= 500)
    throw new IndexerUnavailableError("Indexed data service is unavailable");
  let result;
  try {
    result = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new IndexerUnavailableError("Invalid response from indexed data service");
  }
  if (!result || typeof result !== "object" ||
    (!result.data && !result.errors?.length && !result.error))
    throw new IndexerUnavailableError("Invalid response from indexed data service");
  const message = result.errors?.[0]?.message ?? result.error ?? "Indexed data is unavailable";
  if (result.errors?.some((error: { message?: string }) =>
    /warming or stale/i.test(error.message ?? ""),
  )) throw new IndexerUnavailableError(message);
  if (!response.ok || result.errors?.length || !result.data)
    throw new Error(message);
  return result.data;
}
const inflight = new Map<string, Promise<unknown>>();
export function dedupe<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = inflight.get(key);
  if (previous) return previous as Promise<T>;
  const promise = action().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}
