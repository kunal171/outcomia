"use client";
import { openRevisionStream } from "../lib/graphql/subscriptions";
import { useEffect, useRef } from "react";
import { INDEXER_ENABLED } from "../lib/graphql/client";
export function useIndexerUpdates(update: () => void) {
  const action = useRef(update);
  action.current = update;
  useEffect(() => {
    if (!INDEXER_ENABLED) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
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
    const notify = () =>
      window.dispatchEvent(new CustomEvent("outcomia:indexed-update"));
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
                  notify();
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        } catch {
          /* Reconnect and obtain a complete committed revision. */
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
    return () => controller.abort();
  }, [owner]);
}
