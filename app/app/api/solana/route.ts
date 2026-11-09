import { resolveHeliusDevnetUrl } from "../../../lib/rpc-config";
import { handleRpcProxy } from "../../../lib/rpc-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    return await handleRpcProxy(request, {
      endpoint:
        resolveHeliusDevnetUrl(
          process.env.HELIUS_RPC_URL,
          process.env.HELIUS_API_KEY,
        ) ?? "https://api.devnet.solana.com",
      programId:
        process.env.NEXT_PUBLIC_OUTCOMIA_PROGRAM_ID ??
        process.env.NEXT_PUBLIC_TIDEBOOK_PROGRAM_ID ??
        "AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL",
    });
  } catch {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "RPC not configured" },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
