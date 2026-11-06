/** Server-side RPC forwarding. The upstream URL/key never becomes response data.
 * Small bounds protect the research endpoint; the per-instance limiter is not a
 * distributed quota. Signed broadcasts are forwarded once, without retry. */
const METHODS = new Set([
  "getGenesisHash",
  "getSlot",
  "getBlockTime",
  "getVersion",
  "isBlockhashValid",
  "getRecentPrioritizationFees",
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getTokenAccountsByOwner",
  "getBalance",
  "getLatestBlockhash",
  "getBlockHeight",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTransaction",
  "getFeeForMessage",
  "getMinimumBalanceForRentExemption",
  "sendTransaction",
  "simulateTransaction",
]);
interface Message {
  jsonrpc: string;
  id: string | number | null;
  method: string;
  params?: unknown[];
}
interface Config {
  endpoint: string;
  programId: string;
  fetcher?: typeof fetch;
}
const REQUEST_LIMIT = 64 * 1024,
  RESPONSE_LIMIT = 4 * 1024 * 1024;
let windowId = 0;
const peers = new Map<string, number>();
function reply(status: number, message: string, id: Message["id"] = null) {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code: -32000, message } },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(status === 429 ? { "Retry-After": "10" } : {}),
      },
    },
  );
}
async function boundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
) {
  if (!body) return "";
  const reader = body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error("size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
function valid(input: unknown, programId: string): input is Message {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const m = input as Message;
  if (
    m.jsonrpc !== "2.0" ||
    (!["string", "number"].includes(typeof m.id) && m.id !== null) ||
    !METHODS.has(m.method) ||
    (m.params !== undefined && !Array.isArray(m.params))
  )
    return false;
  const p = m.params ?? [];
  if (m.method === "getProgramAccounts" && p[0] !== programId) return false;
  if (
    m.method === "getMultipleAccounts" &&
    (!Array.isArray(p[0]) || p[0].length > 100)
  )
    return false;
  if (
    m.method === "getSignatureStatuses" &&
    (!Array.isArray(p[0]) || p[0].length > 100)
  )
    return false;
  if (m.method === "getSignaturesForAddress") {
    const config = p[1] as { limit?: number } | undefined;
    if (
      !config ||
      !Number.isInteger(config.limit) ||
      config.limit! < 1 ||
      config.limit! > 20
    )
      return false;
  }
  return true;
}
/** Forward only the app's RPC methods to a fixed devnet endpoint.
 * Inputs: POST request and server-only endpoint; errors stay generic and key-free.
 * Returns: bounded RPC JSON, preserving upstream HTTP throttling for client failover. */
export async function handleRpcProxy(
  request: Request,
  config: Config,
): Promise<Response> {
  if (request.method !== "POST") return reply(405, "POST required");
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(request.url).origin)
        return reply(403, "Origin not allowed");
    } catch {
      return reply(403, "Origin not allowed");
    }
  }
  if (!request.headers.get("content-type")?.includes("application/json"))
    return reply(415, "JSON required");
  const current = Math.floor(Date.now() / 10_000);
  if (current !== windowId) {
    windowId = current;
    peers.clear();
  }
  const peer =
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0] ??
    "local";
  if (peers.size >= 10_000 && !peers.has(peer))
    return reply(429, "RPC busy; retry later");
  const count = (peers.get(peer) ?? 0) + 1;
  peers.set(peer, count);
  if (count > 60) return reply(429, "RPC busy; retry later");
  let payload: unknown;
  try {
    payload = JSON.parse(await boundedText(request.body, REQUEST_LIMIT));
  } catch {
    return reply(400, "Invalid or oversized RPC request");
  }
  const batch = Array.isArray(payload) ? payload : [payload];
  if (
    batch.length < 1 ||
    batch.length > 25 ||
    !batch.every((m) => valid(m, config.programId))
  )
    return reply(400, "RPC method or parameters not allowed");
  const charged = (peers.get(peer) ?? 0) + batch.length - 1;
  peers.set(peer, charged);
  if (charged > 60) return reply(429, "RPC busy; retry later");
  try {
    // Never accept an upstream URL from request data: this is not an open proxy.
    const endpoint = new URL(config.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      !["devnet.helius-rpc.com", "api.devnet.solana.com"].includes(
        endpoint.hostname,
      )
    )
      return reply(503, "RPC not configured");
    const response = await (config.fetcher ?? fetch)(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      return reply(
        response.status === 429 ? 429 : 503,
        "RPC upstream unavailable",
      );
    let text = await boundedText(response.body, RESPONSE_LIMIT);
    // Providers sometimes include the request URL in errors. Redact before returning any JSON.
    const secrets = [
      endpoint.toString(),
      endpoint.searchParams.get("api-key"),
    ].filter((s): s is string => !!s);
    for (const secret of secrets) text = text.split(secret).join("<redacted>");
    JSON.parse(text);
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return reply(503, "RPC upstream unavailable");
  }
}
