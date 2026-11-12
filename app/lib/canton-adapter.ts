import type { CantonSession } from "./canton-session";
import { loadWallet, readSession } from "./console-wallet";
import { loadLoopWallet, readLoopSession } from "./loop-wallet";

export type CantonWalletId = CantonSession["wallet"];

/** Provider differences stop here. No SDK access tokens or account payloads
 * cross this boundary; callers receive verified public identity only.
 */
export async function cantonAdapter(id: CantonWalletId) {
  if (id === "loop") {
    const { provider } = await loadLoopWallet();
    return {
      read: readLoopSession,
      connect: async () => {
        await provider.request({ method: "connect" });
        return readLoopSession();
      },
      disconnect: async () => {
        await provider.request({ method: "disconnect" });
      },
      watch: (changed: () => void) => {
        provider.on("accountsChanged", changed);
        provider.on("statusChanged", changed);
        return () => {
          provider.removeListener("accountsChanged", changed);
          provider.removeListener("statusChanged", changed);
        };
      },
    };
  }
  const wallet = await loadWallet();
  return {
    read: () => readSession(wallet),
    connect: async () => {
      const availability = await wallet.checkExtensionAvailability();
      if (availability.status !== "installed")
        throw new Error(
          "Install Console Wallet to continue, then reload this page.",
        );
      if (availability.isExtensionCapableByVersion === false)
        throw new Error("Update Console Wallet before connecting.");
      const result = await wallet.connect({
        name: "Outcomia",
        target: "local",
      });
      if (!result.isConnected)
        throw new Error("The wallet connection was not approved.");
      return readSession(wallet);
    },
    disconnect: async () => {
      await wallet.disconnect();
    },
    watch: (changed: () => void) => {
      const remove = [
        wallet.onAccountsChanged({ id: "outcomia-canton-account" }, changed),
        wallet.onConnectionStatusChanged(
          { id: "outcomia-canton-status" },
          changed,
        ),
      ];
      return () => remove.forEach((unsubscribe) => unsubscribe());
    },
  };
}
