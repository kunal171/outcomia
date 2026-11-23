import type { CantonSession } from "./canton-session";
import type { Cip103Provider } from "./canton/cip103.ts";
import { loadConsoleProvider, readSession } from "./console-wallet";
import { loadLoopWallet, readLoopSession } from "./loop-wallet";

/** The connected wallet's CIP-0103 provider. Loop ships one natively; Console
 * is adapted in `console-wallet.ts`. Callers never see SDK-specific methods. */
export async function cantonProvider(
  wallet: CantonSession["wallet"],
): Promise<Cip103Provider> {
  return wallet === "loop"
    ? (await loadLoopWallet()).provider
    : loadConsoleProvider();
}

/** Live, verified identity from the wallet's `status` and primary account. */
export function readCantonSession(
  wallet: CantonSession["wallet"],
): Promise<CantonSession> {
  return wallet === "loop" ? readLoopSession() : readSession();
}
