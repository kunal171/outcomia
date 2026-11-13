import { catalog } from "../../../../lib/canton/server";
export const runtime = "nodejs";
export async function GET() {
  try {
    const result = await catalog(process.env);
    return Response.json(result ?? { configured: false }, {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    console.error("Canton public catalog read failed");
    return Response.json(
      { error: "Canton markets are temporarily unavailable." },
      { status: 503 },
    );
  }
}
