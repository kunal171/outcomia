/** Resolve a browser Helius endpoint without logging its key. */
export function resolveHeliusDevnetUrl(
  configuredUrl?: string,
  configuredKey?: string,
): string | null {
  const raw = configuredUrl?.trim();
  const key = configuredKey?.trim();
  if (!raw && !key) return null;
  let url: URL;
  try {
    url = new URL(raw || "https://devnet.helius-rpc.com");
  } catch {
    throw new Error(
      "NEXT_PUBLIC_HELIUS_RPC_URL must be a valid Helius devnet URL",
    );
  }
  if (url.protocol !== "https:" || url.hostname !== "devnet.helius-rpc.com")
    throw new Error("Use the HTTPS Helius devnet endpoint for this devnet app");
  if (key) url.searchParams.set("api-key", key);
  // A base URL without a key is only a placeholder, not a usable primary.
  if (!url.searchParams.get("api-key")) return null;
  return url.toString();
}
