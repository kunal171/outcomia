import { registryContext } from "../../../../lib/canton/server";
export const runtime = "nodejs";
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const body = await request.text();
    if (body.length > 65536)
      return Response.json({ error: "Request too large." }, { status: 413 });
    return Response.json(await registryContext(process.env, JSON.parse(body)), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    console.error("Canton registry context read failed");
    return Response.json(
      { error: "Registry transfer context is unavailable." },
      { status: 503 },
    );
  }
}
