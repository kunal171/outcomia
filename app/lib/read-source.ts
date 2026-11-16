/** Availability is tracked per dataset; a warming wallet does not disable market reads. */
import { INDEXER_ENABLED, IndexerUnavailableError } from "./graphql/client";

const retryDelay = 15000;
type Failure = { retryAt: number; recovery?: Promise<boolean> };
const failures = new Map<string, Failure>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

export function subscribeReadSource(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function hasRpcFallback(owner = "") {
  return failures.has("accounts") || (owner !== "" &&
    [...failures.keys()].some((key) => key.startsWith(`wallet:${owner}:`)));
}

/** Only availability failures trigger fallback; invalid filters/data remain errors. */
export async function readWithRpcFallback<T>(
  key: string,
  indexed: () => Promise<T>,
  rpc: () => Promise<T>,
): Promise<T> {
  if (!INDEXER_ENABLED) return rpc();
  const previous = failures.get(key);
  if (previous) {
    if (previous.recovery) {
      if (!(await previous.recovery)) return rpc();
      return readWithRpcFallback(key, indexed, rpc);
    }
    if (Date.now() < previous.retryAt) return rpc();
  }
  let resolveRecovery: ((healthy: boolean) => void) | undefined;
  if (previous) previous.recovery = new Promise((resolve) => { resolveRecovery = resolve; });
  try {
    const value = await indexed();
    if (previous && failures.get(key) === previous) {
      failures.delete(key);
      changed();
    }
    resolveRecovery?.(true);
    return value;
  } catch (error) {
    resolveRecovery?.(false);
    if (!(error instanceof IndexerUnavailableError)) {
      if (previous) previous.recovery = undefined;
      throw error;
    }
    failures.set(key, { retryAt: Date.now() + retryDelay });
    if (!previous) changed();
    return rpc();
  }
}
