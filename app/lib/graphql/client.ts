/** Shared HTTP transport and in-flight deduplication. Resolvers stay on the indexer. */
export const INDEXER_ENABLED =
  process.env.NEXT_PUBLIC_INDEXER_ENABLED === "true";
export async function graphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api/indexer/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal,
  });
  const result = await response.json();
  if (!response.ok || result.errors?.length || !result.data)
    throw new Error(
      result.errors?.[0]?.message ??
        result.error ??
        "Indexed data is unavailable",
    );
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
