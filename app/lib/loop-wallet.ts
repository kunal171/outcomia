import { verifyLoopSession } from "./canton-session";
import { expectedNetwork } from "./console-wallet";

/** Initialize once: reinitializing Loop invalidates its CIP-0103 bridge. The
 * browser SDK owns session credentials; none are copied into application state.
 */
let client:
  | Promise<{
      provider: ReturnType<
        (typeof import("@fivenorth/loop-sdk"))["loop"]["getCip103Provider"]
      >;
    }>
  | undefined;
export function loadLoopWallet() {
  client ??= import("@fivenorth/loop-sdk").then((sdk) => {
    sdk.loop.init({
      appName: "Outcomia",
      network: expectedNetwork.replace("canton:", "") as
        "devnet" | "testnet" | "mainnet",
    });
    return {
      provider: sdk.loop.getCip103Provider({ connectTimeoutMs: 120000 }),
    };
  });
  return client;
}

/** The native bridge verifies authenticated account metadata against Loop's
 * backend identity. Reject absent network health and mismatched CAIP-2 IDs.
 */
export async function readLoopSession() {
  const { provider } = await loadLoopWallet();
  const status = await provider.request({ method: "status" });
  const account = await provider.request({ method: "getPrimaryAccount" });
  return verifyLoopSession(status, account, expectedNetwork);
}
