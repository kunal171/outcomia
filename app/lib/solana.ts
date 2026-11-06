import { clusterApiUrl, PublicKey } from "@solana/web3.js";
import { resolveHeliusDevnetUrl } from "./rpc-config";

export const NETWORK = "devnet" as const;
const heliusEndpoint = resolveHeliusDevnetUrl(
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL,
  process.env.NEXT_PUBLIC_HELIUS_API_KEY,
);
const genericEndpoint =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() || clusterApiUrl(NETWORK);
export const RPC_ENDPOINT = heliusEndpoint ?? genericEndpoint;

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
