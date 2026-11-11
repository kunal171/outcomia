/** Public session identity only. Wallet tokens and signing material never enter app state. */
export type CantonNetwork =
  "canton:devnet" | "canton:testnet" | "canton:mainnet";
export type CantonSession = {
  chain: "canton";
  wallet: "console";
  partyId: string;
  networkId: CantonNetwork;
};

const accountNetworks: Record<string, CantonNetwork> = {
  CANTON_NETWORK_DEV: "canton:devnet",
  CANTON_NETWORK_TEST: "canton:testnet",
  CANTON_NETWORK: "canton:mainnet",
};

export function configuredNetwork(value = "canton:devnet"): CantonNetwork {
  if (!["canton:devnet", "canton:testnet", "canton:mainnet"].includes(value)) {
    throw new Error(
      "Configure NEXT_PUBLIC_CANTON_NETWORK_ID with a Canton CAIP-2 network ID.",
    );
  }
  return value as CantonNetwork;
}

/** Validate live wallet responses; an account string or saved preference is not a session. */
export function verifySession(
  status: {
    connection: { isConnected: boolean; isNetworkConnected?: boolean };
    network?: { networkId: string };
  },
  account:
    | { partyId: string; networkId: string; status: string; primary: boolean }
    | undefined,
  network: { networkId: string },
  expected: CantonNetwork,
): CantonSession {
  if (
    !status.connection.isConnected ||
    status.connection.isNetworkConnected === false
  ) {
    throw new Error("Console Wallet is not connected to Canton.");
  }
  if (!account || !account.primary || account.status !== "allocated") {
    throw new Error("Select an allocated primary party in Console Wallet.");
  }
  if (!/^[A-Za-z0-9:_-]+::[A-Za-z0-9:_-]+$/.test(account.partyId)) {
    throw new Error("Console Wallet returned an invalid Canton party.");
  }
  if (
    network.networkId !== expected ||
    accountNetworks[account.networkId] !== expected ||
    (status.network && status.network.networkId !== expected)
  ) {
    throw new Error(
      `Switch Console Wallet to ${expected.replace("canton:", "")} and reconnect.`,
    );
  }
  return {
    chain: "canton",
    wallet: "console",
    partyId: account.partyId,
    networkId: expected,
  };
}
