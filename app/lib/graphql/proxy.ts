/** Same-origin boundary keeps HttpOnly sessions out of browser JavaScript. */
const paths = new Set([
  "graphql",
  "graphql/stream",
  "auth/challenge",
  "auth/verify",
  "auth/me",
  "auth/logout",
]);
/** Rate-limit identity for the indexer's sign-in limits.
 * Vercel sets x-real-ip / x-forwarded-for from the connection, replacing any
 * client-supplied values. The indexer trusts the forwarded IP only together
 * with the shared server-only secret, so callers cannot forge it directly.
 * Returns no headers unless both a secret and a client IP are available. */
export function clientIdentityHeaders(
  request: Request,
  secret: string | undefined,
): Record<string, string> {
  const client =
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!secret || !client) return {};
  return {
    "x-outcomia-client-ip": client,
    "x-outcomia-proxy-token": secret,
  };
}
export async function proxyIndexerRequest(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const path = (await context.params).path.join("/");
  if (!paths.has(path) || (request.method === "GET" && path !== "auth/me"))
    return new Response("Not found", { status: 404 });
  const requestOrigin = request.headers.get("origin");
  const host = request.headers.get("host") ?? new URL(request.url).host;
  let origin = new URL(request.url).origin;
  if (request.method === "POST") {
    let source: URL;
    try {
      source = new URL(requestOrigin ?? "");
    } catch {
      return Response.json(
        { error: "Request origin mismatch" },
        { status: 403 },
      );
    }
    if (source.host !== host || !["http:", "https:"].includes(source.protocol))
      return Response.json(
        { error: "Request origin mismatch" },
        { status: 403 },
      );
    origin = source.origin;
  }
  const finish = (response: Response) => {
    if (path === "auth/logout")
      for (const name of ["outcomia_session", "outcomia_challenge"])
        response.headers.append(
          "Set-Cookie",
          `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${origin.startsWith("https:") ? "; Secure" : ""}`,
        );
    return response;
  };
  const endpoint = process.env.INDEXER_API_URL;
  if (!endpoint)
    return finish(
      Response.json(
        { error: "Indexed data service is not configured" },
        { status: 503 },
      ),
    );
  try {
    const base = new URL(endpoint);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password
    )
      throw new Error("Invalid indexer endpoint");
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && new TextEncoder().encode(body).length > 32768)
      return new Response("Request too large", { status: 413 });
    const headers = new Headers({
      "Content-Type": "application/json",
      Origin: origin,
      ...clientIdentityHeaders(request, process.env.INDEXER_PROXY_SECRET),
    });
    const cookie = request.headers.get("cookie");
    if (cookie) headers.set("cookie", cookie);
    const streaming = path === "graphql/stream";
    const response = await fetch(
      new URL(path, `${base.href.replace(/\/$/, "")}/`),
      {
        method: request.method,
        headers,
        body,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(streaming ? 240000 : 15000),
        ]),
      },
    );
    const output = new Headers({
      "Cache-Control": "no-store",
      "Content-Type":
        response.headers.get("content-type") ?? "application/json",
    });
    for (const value of response.headers.getSetCookie())
      output.append("set-cookie", value);
    if (streaming) output.set("X-Accel-Buffering", "no");
    return finish(
      new Response(response.body, { status: response.status, headers: output }),
    );
  } catch {
    return finish(
      Response.json(
        { error: "Indexed data service is unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }
}
