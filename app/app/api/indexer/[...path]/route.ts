/** Same-origin boundary keeps HttpOnly sessions out of browser JavaScript. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const paths = new Set(["graphql", "graphql/stream", "auth/challenge", "auth/verify", "auth/me", "auth/logout"]);
async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path.join("/");
  if (!paths.has(path) || (request.method === "GET" && path !== "auth/me"))
    return new Response("Not found", { status: 404 });
  const origin = new URL(request.url).origin;
  if (request.method === "POST" && request.headers.get("origin") !== origin)
    return Response.json({ error: "Request origin mismatch" }, { status: 403 });
  const endpoint = process.env.INDEXER_API_URL;
  if (!endpoint) return Response.json({ error: "Indexed data service is not configured" }, { status: 503 });
  try {
    const base = new URL(endpoint);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
      throw new Error("Invalid indexer endpoint");
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && new TextEncoder().encode(body).length > 32768)
      return new Response("Request too large", { status: 413 });
    const headers = new Headers({ "Content-Type": "application/json", "Origin": origin });
    const cookie = request.headers.get("cookie");
    if (cookie) headers.set("cookie", cookie);
    const streaming = path === "graphql/stream";
    const response = await fetch(new URL(path, `${base.href.replace(/\/$/, "")}/`), {
      method: request.method, headers, body, cache: "no-store", redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(streaming ? 240000 : 15000)]),
    });
    const output = new Headers({ "Cache-Control": "no-store", "Content-Type": response.headers.get("content-type") ?? "application/json" });
    for (const value of response.headers.getSetCookie()) output.append("set-cookie", value);
    if (streaming) output.set("X-Accel-Buffering", "no");
    return new Response(response.body, { status: response.status, headers: output });
  } catch {
    return Response.json({ error: "Indexed data service is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
export const GET = proxy;
export const POST = proxy;
