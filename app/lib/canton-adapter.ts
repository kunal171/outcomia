import type { CantonSession } from "./canton-session";
import { cantonProvider, readCantonSession } from "./canton-provider";

export type CantonWalletId = CantonSession["wallet"];

/** Connection lifecycle through the CIP-0103 provider, identical for every
 * wallet: `connect`, `disconnect`, and `accountsChanged`/`statusChanged`.
 * No SDK access tokens or account payloads cross this boundary; callers
 * receive verified public identity only.
 */
export async function cantonAdapter(id: CantonWalletId) {
  const provider = await cantonProvider(id);
  return {
    read: () => readCantonSession(id),
    connect: async () => {
      const result = await provider.request<{ isConnected?: boolean }>({
        method: "connect",
      });
      if (result && result.isConnected === false)
        throw new Error("The wallet connection was not approved.");
      return readCantonSession(id);
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
