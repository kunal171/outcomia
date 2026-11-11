import { configuredNetwork, verifySession } from "./canton-session";

// Import only in the browser. The SDK owns approval, transport and signing.
export const loadWallet = async () =>
  (await import("@console-wallet/dapp-sdk")).consoleWallet;
export const expectedNetwork = configuredNetwork(
  process.env.NEXT_PUBLIC_CANTON_NETWORK_ID,
);

export async function readSession(
  wallet: Awaited<ReturnType<typeof loadWallet>>,
) {
  const status = await wallet.status();
  const [account, network] = await Promise.all([
    wallet.getPrimaryAccount(),
    wallet.getActiveNetwork(),
  ]);
  return verifySession(status, account, network, expectedNetwork);
}

/** Keep wallet-provided diagnostics useful without rendering arbitrary objects. */
export function walletError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (
    typeof cause === "object" &&
    cause &&
    "message" in cause &&
    typeof cause.message === "string"
  )
    return cause.message;
  return "Wallet connection failed. Check Console Wallet and try again.";
}
