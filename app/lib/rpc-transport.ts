/** Bounded HTTP RPC reads: coalesce duplicates, pace requests and fail over on outages. */
import type { ConnectionConfig } from "@solana/web3.js";

type RpcFetch = NonNullable<ConnectionConfig["fetch"]>;
interface RpcMessage {
  jsonrpc?: string;
  id: unknown;
  method: string;
  params?: unknown;
}
interface RpcReply {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export function rpcErrorMessage(
  cause: unknown,
  fallback = "Unable to load network data",
): string {
  const message = cause instanceof Error ? cause.message : fallback;
  return /429|too many requests|rate.limit|RPC providers.*busy/i.test(message)
    ? "The devnet RPC providers are busy. Please wait a moment, then refresh."
    : message;
}

/** Inputs: HTTP endpoints for this app's devnet cluster and an optional fetch implementation.
 * Reads try each provider at most once. Writes use one verified provider and are
 * never replayed after a network error. Genesis checks reject mainnet/testnet.
 * Account reads are only coalesced while in flight; live balance and planning
 * reads are not served from a TTL cache. Discovery/history use short caches.
 * WebSocket subscriptions use the provider's separate public devnet WS endpoint.
 */
export function createRpcFetch(
  endpoints: string[],
  baseFetch: RpcFetch = globalThis.fetch,
): RpcFetch {
  const urls = [...new Set(endpoints)];
  if (!urls.length)
    throw new Error("Configure at least one devnet RPC endpoint");
  const states = urls.map(() => ({
    until: 0,
    wrongCluster: false,
    verified: false,
    probe: null as Promise<void> | null,
  }));
  const pending = new Map<string, Promise<RpcReply>>();
  const cache = new Map<string, { until: number; reply: RpcReply }>();
  let preferred = 0;
  let generation = 0;
  let active = 0;
  const waiters: Array<() => void> = [];
  let nextStart = 0;
  let pacing = Promise.resolve();

  async function acquire() {
    if (active < 3) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  function release() {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }
  async function pace() {
    const turn = pacing.then(async () => {
      const delay = Math.max(0, nextStart - Date.now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      nextStart = Date.now() + 300;
    });
    pacing = turn.catch(() => {});
    await turn;
  }

  async function request(
    index: number,
    message: RpcMessage,
    init?: Parameters<RpcFetch>[1],
  ): Promise<RpcReply> {
    await acquire();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    try {
      await pace();
      if (states[index].until > Date.now())
        throw new Error("RPC providers are busy");
      if (init?.signal?.aborted) throw new Error("RPC request cancelled");
      init?.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, 12000);
      const response = await baseFetch(urls[index], {
        ...init,
        body: JSON.stringify(message),
        signal: controller.signal,
        // Never forward a primary provider's authentication headers to another.
        headers:
          index === 0 ? init?.headers : { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const retryHeader = response.headers.get("Retry-After");
        const retryMs =
          retryHeader && /^\d+$/.test(retryHeader)
            ? Number(retryHeader) * 1000
            : retryHeader
              ? Math.max(0, Date.parse(retryHeader) - Date.now())
              : 0;
        states[index].until =
          Date.now() +
          Math.min(
            120000,
            Math.max(30000, Number.isFinite(retryMs) ? retryMs : 0),
          );
        throw new Error("RPC providers are busy or temporarily unavailable");
      }
      const reply = (await response.json()) as RpcReply;
      if (
        reply.error &&
        (reply.error.code === 429 ||
          reply.error.code === -32005 ||
          reply.error.code === -32601 ||
          /rate.limit|too many|unavailable|unhealthy|node.*behind/i.test(
            reply.error.message,
          ))
      ) {
        states[index].until = Date.now() + 30000;
        throw new Error("RPC providers are busy or temporarily unavailable");
      }
      if (!("result" in reply) && !reply.error)
        throw new Error("Invalid RPC response");
      return reply;
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener("abort", abort);
      release();
    }
  }

  async function verify(index: number, init?: Parameters<RpcFetch>[1]) {
    const state = states[index];
    if (state.verified) return;
    if (state.wrongCluster)
      throw new Error("RPC endpoint is not Solana devnet");
    if (!state.probe)
      state.probe = request(
        index,
        {
          jsonrpc: "2.0",
          id: "tidebook-cluster-check",
          method: "getGenesisHash",
        },
        init,
      )
        .then((reply) => {
          if (reply.error) throw new Error("RPC cluster check unavailable");
          if (reply.result !== DEVNET_GENESIS) {
            state.wrongCluster = true;
            throw new Error("RPC endpoint is not Solana devnet");
          }
          state.verified = true;
        })
        .finally(() => {
          state.probe = null;
        });
    await state.probe;
  }

  async function execute(
    message: RpcMessage,
    init?: Parameters<RpcFetch>[1],
  ): Promise<RpcReply> {
    const isRead =
      message.method.startsWith("get") ||
      message.method === "isBlockhashValid" ||
      message.method === "simulateTransaction";
    if (!isRead) {
      generation++;
      cache.clear();
    }
    // Retry the configured primary after its cooldown; a successful public
    // fallback must not permanently displace Helius.
    const order = [...new Set([0, preferred, ...urls.map((_, i) => i)])];
    for (const index of order) {
      if (states[index].wrongCluster || states[index].until > Date.now())
        continue;
      try {
        await verify(index, init);
      } catch (cause) {
        if (init?.signal?.aborted) throw cause;
        states[index].until = Date.now() + 30000;
        continue;
      }
      try {
        const reply = await request(index, message, init);
        preferred = index;
        if (!isRead) {
          generation++;
          cache.clear();
        }
        return reply;
      } catch (cause) {
        if (init?.signal?.aborted) throw cause;
        states[index].until = Math.max(states[index].until, Date.now() + 10000);
        // A failed broadcast may have reached the network. Do not send it again.
        if (!isRead)
          throw new Error(
            "Transaction RPC request failed. Check your wallet's transaction history before retrying.",
          );
      }
    }
    if (states.every((state) => state.wrongCluster))
      throw new Error("Configured RPC endpoints are not Solana devnet");
    throw new Error(
      "RPC providers are busy. Please wait a moment, then refresh.",
    );
  }

  async function single(
    message: RpcMessage,
    init?: Parameters<RpcFetch>[1],
  ): Promise<RpcReply> {
    const isRead =
      message.method.startsWith("get") ||
      message.method === "isBlockhashValid" ||
      message.method === "simulateTransaction";
    const key = JSON.stringify([generation, message.method, message.params]);
    const ttl =
      message.method === "getProgramAccounts" ||
      message.method === "getSignaturesForAddress"
        ? 3000
        : message.method === "getTransaction"
          ? 60000
          : 0;
    if (isRead && !init?.signal) {
      const saved = cache.get(key);
      if (saved && saved.until > Date.now())
        return { ...saved.reply, id: message.id };
      if (!pending.has(key)) {
        const work = execute(message, init)
          .then((reply) => {
            if (ttl && !reply.error && reply.result !== null) {
              if (cache.size >= 128) cache.delete(cache.keys().next().value!);
              cache.set(key, { until: Date.now() + ttl, reply });
            }
            return reply;
          })
          .finally(() => pending.delete(key));
        pending.set(key, work);
      }
      return { ...(await pending.get(key)!), id: message.id };
    }
    return execute(message, init);
  }

  return async (input, init) => {
    if (typeof init?.body !== "string") return baseFetch(input, init);
    let message: RpcMessage | RpcMessage[];
    try {
      message = JSON.parse(init.body);
    } catch {
      return baseFetch(input, init);
    }
    const result = Array.isArray(message)
      ? await Promise.all(message.map((item) => single(item, init)))
      : await single(message, init);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  };
}
