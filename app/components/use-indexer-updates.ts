"use client";
import { hasRpcFallback, subscribeReadSource } from "../lib/read-source";
import { openRevisionStream } from "../lib/graphql/subscriptions";
import { useEffect, useRef } from "react";
import { INDEXER_ENABLED } from "../lib/graphql/client";
/**
 * Runs `update` after live index changes (coalesced over 150 ms). With a
 * `scope` (market, wallet and other addresses this view shows), changes the
 * indexer attributes only to other addresses are ignored, so a trade on one
 * market does not refresh every open page. Unattributed changes (reconnects,
 * resyncs, large revisions) always refresh.
 */
export function useIndexerUpdates(
  update: () => void,
  scope?: (string | null | undefined)[],
) {
  const action = useRef(update);
  action.current = update;
  const watched = useRef<Set<string> | null>(null);
  watched.current = scope
    ? new Set(scope.filter((s): s is string => !!s))
    : null;
  useEffect(() => {
    if (!INDEXER_ENABLED) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = (event: Event) => {
      const names = (event as CustomEvent<{ scope?: string[] | null }>).detail
        ?.scope;
      const mine = watched.current;
      if (mine && Array.isArray(names) && !names.some((n) => mine.has(n)))
        return;
      clearTimeout(timer);
      timer = setTimeout(() => action.current(), 150);
    };
    window.addEventListener("outcomia:indexed-update", changed);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("outcomia:indexed-update", changed);
    };
  }, []);
}
/** One reconnecting GraphQL revision stream per active Solana workspace. */
export function useIndexerStream(owner: string) {
  useEffect(() => {
    if (!INDEXER_ENABLED) return;
    const controller = new AbortController();
    const notify = (scope: string[] | null = null) =>
      window.dispatchEvent(
        new CustomEvent("outcomia:indexed-update", { detail: { scope } }),
      );
    /** The scope a revision event names, or null (refresh everything). */
    const scopeOf = (event: string): string[] | null => {
      try {
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5))
          .join("");
        const revision = JSON.parse(data)?.data?.revisions;
        return revision && !revision.resync && Array.isArray(revision.scope)
          ? revision.scope.filter((s: unknown) => typeof s === "string")
          : null;
      } catch {
        return null;
      }
    };
    let fallback = hasRpcFallback(owner);
    const stopWatching = subscribeReadSource(() => {
      const next = hasRpcFallback(owner);
      if (fallback && !next) notify();
      fallback = next;
    });
    // The stream may be unavailable too. Keep current RPC reads live and retry GraphQL.
    const polling = setInterval(() => {
      if (hasRpcFallback(owner)) notify();
    }, 15000);
    void (async () => {
      let delay = 1000;
      while (!controller.signal.aborted) {
        try {
          const response = await openRevisionStream(owner, controller.signal);
          if (!response.ok || !response.body)
            throw new Error("Live index unavailable");
          delay = 1000;
          notify();
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              pending += decoder.decode(value, { stream: true });
              if (pending.length > 65536)
                throw new Error("Invalid revision stream");
              let boundary: number;
              while ((boundary = pending.indexOf("\n\n")) >= 0) {
                const event = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                if (event.split("\n").some((line) => line.startsWith("data:")))
                  notify(scopeOf(event));
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        } catch {
          // Detect an outage even before a user manually refreshes the screen.
          if (!controller.signal.aborted && !hasRpcFallback(owner)) notify();
        }
        if (!controller.signal.aborted)
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, delay);
            controller.signal.addEventListener("abort", finish, { once: true });
          });
        delay = Math.min(delay * 2, 30000);
      }
    })();
    return () => {
      controller.abort();
      clearInterval(polling);
      stopWatching();
    };
  }, [owner]);
}
