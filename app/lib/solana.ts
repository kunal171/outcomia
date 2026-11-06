import { clusterApiUrl, PublicKey } from "@solana/web3.js";
export const NETWORK = "devnet" as const;
const genericEndpoint =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() || clusterApiUrl(NETWORK);
const proxyEnabled = process.env.NEXT_PUBLIC_RPC_PROXY_ENABLED === "true";
// The endpoint is configuration, not rendered HTML. Server rendering uses the
// public fallback; each browser calls its own deployment's same-origin route.
export const RPC_ENDPOINT =
  proxyEnabled && typeof window !== "undefined"
    ? new URL("/api/solana", window.location.origin).toString()
    : genericEndpoint;
export const RPC_WS_ENDPOINT =
  process.env.NEXT_PUBLIC_SOLANA_WS_URL?.trim() ||
  "wss://api.devnet.solana.com/";

// Public providers still have quotas. Extra keyed/free-tier devnet URLs can be
// supplied without code changes; the transport verifies each cluster identity.
export const RPC_ENDPOINTS = [
  ...new Set([
    RPC_ENDPOINT,
    genericEndpoint,
    ...(
      process.env.NEXT_PUBLIC_SOLANA_RPC_FALLBACK_URLS ??
      "https://solana-devnet.api.onfinality.io/public,https://api.devnet.solana.com"
    )
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),
  ]),
];

const configuredProgramId = process.env.NEXT_PUBLIC_TIDEBOOK_PROGRAM_ID;

if (!configuredProgramId) {
  throw new Error("NEXT_PUBLIC_TIDEBOOK_PROGRAM_ID is not configured");
}

export const PROGRAM_ID = new PublicKey(configuredProgramId);

export const PROGRAM_EXPLORER_URL = `https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=${NETWORK}`;
