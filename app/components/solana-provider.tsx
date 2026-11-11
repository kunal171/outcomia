"use client";

import { useLayoutEffect, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { LocalizedWalletModalProvider } from "./localized-wallet-modal";
import { RPC_ENDPOINT, RPC_ENDPOINTS, RPC_WS_ENDPOINT } from "../lib/solana";
import { createRpcFetch } from "../lib/rpc-transport";

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
      <WalletProvider wallets={wallets} autoConnect={false}>
        <LocalizedWalletModalProvider>{children}</LocalizedWalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

/** Give each mounted Solana workspace its own cancellable HTTP transport.
 * Closing the workspace aborts in-flight requests and prevents paced/queued
 * requests from reaching an upstream after a switch to another network.
 * A fresh lease on Strict Mode effect replay keeps development restores valid.
 */
export function SolanaWorkspaceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const transport = useMemo(() => {
    const lease = { active: true, controller: new AbortController() };
    const fetch = createRpcFetch(RPC_ENDPOINTS, async (input, init) => {
      if (!lease.active) throw new Error("Solana workspace is disconnected.");
      const signal = init?.signal
        ? AbortSignal.any([init.signal, lease.controller.signal])
        : lease.controller.signal;
      return globalThis.fetch(input, { ...init, signal });
    });
    return {
      lease,
      config: {
        commitment: "confirmed" as const,
        disableRetryOnRateLimit: true,
        wsEndpoint: RPC_WS_ENDPOINT,
        fetch,
      },
    };
  }, []);
  useLayoutEffect(() => {
    transport.lease.active = true;
    if (transport.lease.controller.signal.aborted)
      transport.lease.controller = new AbortController();
    return () => {
      transport.lease.active = false;
      transport.lease.controller.abort();
    };
  }, [transport]);
  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT} config={transport.config}>
      {children}
    </ConnectionProvider>
  );
}
