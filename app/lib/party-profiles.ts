/** Batched, cached profile lookups for Canton parties. Lists render many
 * parties at once; their lookups share one request per tick, and results are
 * reused for a minute. A failed lookup resolves to null (no name shown). */
import type { Profile } from "./graphql/social";

type Entry = { at: number; value: Promise<Profile | null> };
const TTL_MS = 60_000;

export function createPartyProfiles(
  fetch: (parties: string[]) => Promise<{ party: string; profile: Profile }[]>,
  now: () => number = Date.now,
) {
  const cache = new Map<string, Entry>();
  let queue: { party: string; resolve: (p: Profile | null) => void }[] = [];
  let scheduled = false;

  async function flush() {
    scheduled = false;
    const batch = queue.splice(0, 100);
    if (queue.length) schedule();
    let found = new Map<string, Profile>();
    try {
      found = new Map(
        (await fetch([...new Set(batch.map((b) => b.party))])).map((r) => [
          r.party,
          r.profile,
        ]),
      );
    } catch {
      for (const b of batch) cache.delete(b.party);
    }
    for (const b of batch) b.resolve(found.get(b.party) ?? null);
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => void flush(), 0);
  }

  return function lookup(party: string): Promise<Profile | null> {
    const hit = cache.get(party);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    const value = new Promise<Profile | null>((resolve) => {
      queue.push({ party, resolve });
      schedule();
    });
    cache.set(party, { at: now(), value });
    return value;
  };
}
