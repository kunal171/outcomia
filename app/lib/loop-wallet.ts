import { verifyLoopSession, type CantonSession } from "./canton-session";
import { expectedNetwork } from "./console-wallet";
import { parseLoopAssets } from "./canton-display";

/** Initialize once: reinitializing Loop invalidates its CIP-0103 bridge. The
 * browser SDK owns session credentials; none are copied into application state.
 */
let client: Promise<ReturnType<typeof initialize>> | undefined;
function initialize(sdk: typeof import("@fivenorth/loop-sdk")) {
  let approved:
    | Parameters<
        NonNullable<Parameters<typeof sdk.loop.init>[0]["onAccept"]>
      >[0]
    | undefined;
  sdk.loop.init({
    appName: "Outcomia",
    network: expectedNetwork.replace("canton:", "") as
      | "devnet"
      | "testnet"
      | "mainnet",
    onAccept: (provider) => {
      approved = provider;
    },
  });
  const provider = sdk.loop.getCip103Provider({ connectTimeoutMs: 120000 });
  return {
    provider,
    holdings: () => {
      if (!approved) throw new Error("Loop Wallet is not connected.");
      return approved.getHolding();
    },
  };
}
export function loadLoopWallet() {
  client ??= import("@fivenorth/loop-sdk").then(initialize);
  return client;
}

/** The native bridge verifies authenticated account metadata against Loop's
 * backend identity. Reject absent network health and mismatched CAIP-2 IDs.
 */
export async function readLoopSession(): Promise<CantonSession> {
  const { provider } = await loadLoopWallet();
  const status = await provider.request({ method: "status" });
  const account = await provider.request({ method: "getPrimaryAccount" });
  return verifyLoopSession(status, account, expectedNetwork);
}
export async function readLoopAssets(session: CantonSession) {
  const verify = async () => {
    const current = await readLoopSession();
    if (
      current.partyId !== session.partyId ||
      current.networkId !== session.networkId
    )
      throw new Error("Wallet changed. Refresh balances.");
  };
  await verify();
  const holdings = await (await loadLoopWallet()).holdings();
  await verify();
  return parseLoopAssets(holdings);
}
