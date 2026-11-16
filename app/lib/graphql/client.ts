/** Shared HTTP transport and in-flight deduplication. Resolvers stay on the indexer. */
export const INDEXER_ENABLED =
  process.env.NEXT_PUBLIC_INDEXER_ENABLED === "true";
// A navigation cancellation is not an indexer outage. Abort reads with the page.
let pageLifetime: AbortController | undefined;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  pageLifetime = new AbortController();
  window.addEventListener("pagehide", () => pageLifetime?.abort());
  window.addEventListener("pageshow", () => {
    if (pageLifetime?.signal.aborted) pageLifetime = new AbortController();
  });
}

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
  const lifetime = pageLifetime?.signal;
  const signals = [AbortSignal.timeout(5000), ...(signal ? [signal] : []), ...(lifetime ? [lifetime] : [])];
  const cancelled = (error: unknown) => signal?.aborted || lifetime?.aborted ||
    (error instanceof Error && error.name === "AbortError");
  let response: Response;
  try {
    response = await fetch("/api/indexer/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      signal: AbortSignal.any(signals),
    });
    signal?.throwIfAborted();
    lifetime?.throwIfAborted();
  } catch (error) {
    if (cancelled(error)) throw error;
    throw new IndexerUnavailableError("Indexed data service is unreachable");
  }
  if ([408, 429].includes(response.status) || response.status >= 500)
    throw new IndexerUnavailableError("Indexed data service is unavailable");
  let result;
  try {
    result = await response.json();
  } catch (error) {
    if (cancelled(error)) throw error;
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
