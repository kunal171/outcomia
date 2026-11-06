"use client";

import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { RPC_ENDPOINT, RPC_ENDPOINTS, RPC_WS_ENDPOINT } from "../lib/solana";
import { createRpcFetch } from "../lib/rpc-transport";
import { ProtocolRoleProvider } from "./protocol-role-provider";

export function SolanaProvider({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [], []);
  const config = useMemo(
    () => ({
      commitment: "confirmed" as const,
      disableRetryOnRateLimit: true,
      wsEndpoint: RPC_WS_ENDPOINT,
      fetch: createRpcFetch(RPC_ENDPOINTS),
    }),
    [],
  );

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT} config={config}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <ProtocolRoleProvider>{children}</ProtocolRoleProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
