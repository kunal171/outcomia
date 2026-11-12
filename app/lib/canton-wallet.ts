import type { CantonSession } from "./canton-session";
import { readSession } from "./console-wallet";
import { parseWalletAssets, walletNetworks } from "./canton-display";

/** Read-only SDK request. Reverify both sides of the await so a party/network
 * switch cannot attach someone else's response to the visible wallet session.
 * Signing material and the SDK's optional network access tokens are not retained.
 */
export async function readCantonWalletAssets(session: CantonSession) {
  if (session.wallet === "loop")
    return (await import("./loop-wallet")).readLoopAssets(session);
  const sdk = await import("@console-wallet/dapp-sdk");
  const wallet = sdk.consoleWallet;
  const verify = async () => {
    const current = await readSession(wallet);
    if (
      current.partyId !== session.partyId ||
      current.networkId !== session.networkId
    )
      throw new Error("Wallet changed. Refresh balances.");
  };
  await verify();
  const response = await wallet.getBalance({
    party: session.partyId,
    network: sdk.CANTON_NETWORK_VARIANTS[walletNetworks[session.networkId]],
  });
  await verify();
  return parseWalletAssets(response, session.networkId);
}
