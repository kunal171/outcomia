/** The React consumer owns reconnection and revision invalidation. */
export function openRevisionStream(owner: string, signal: AbortSignal) {
  return fetch("/api/indexer/graphql/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `
        subscription Revisions($owner: String) {
          revisions(owner: $owner) {
            commitment
            revision
            resync
          }
        }
      `,
      variables: { owner },
    }),
    signal,
    cache: "no-store",
  });
}
